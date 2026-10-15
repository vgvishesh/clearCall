/**
 * Local media: capture with voice/music constraints, mic mute (track.enabled), camera off = stop the track (camera
 * light off), camera flip, mode switch, a local level meter, and recovery from track loss (iOS background,
 * device unplug) on `visibilitychange` / `devicechange` / track `ended`.
 *
 * `camOn` is what peers and the UI see: the user wants the camera AND the browser is actually delivering frames. When
 * the browser silences our capture (track `mute`: WebKit when another page takes the camera, iOS in the background)
 * or ends it, `camOn` drops to false (peers show the camera-off avatar) while the user's intent is kept; `unmute`
 * restores it, `ended` goes through recovery (re-acquire on visible).
 *
 * iOS rule: stop the old track BEFORE acquiring its replacement (iOS allows one capture per device; a second
 * getUserMedia otherwise mutes/ends the first), then hand the new track to the transport (`replaceTrack`).
 */
import type { Clock, TimerHandle } from "./clock.ts";
import { errInfo, type Logger, nullLogger } from "./log.ts";
import type { AudioMode, CallError, Facing } from "./types.ts";

export interface MediaDevicesLike {
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices?(): Promise<MediaDeviceInfo[]>;
  addEventListener?(type: "devicechange", fn: () => void): void;
  removeEventListener?(type: "devicechange", fn: () => void): void;
}

/** The slice of AudioContext the meter uses. */
export interface AudioContextLike {
  state: string;
  resume(): Promise<void>;
  close(): Promise<void>;
  createMediaStreamSource(s: MediaStream): { connect(n: unknown): void; disconnect(): void };
  createAnalyser(): { fftSize: number; getFloatTimeDomainData(a: Float32Array): void; disconnect?(): void };
}

export interface DocumentLike {
  visibilityState: string;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

/**
 * Lab/diagnostic overrides of the audio defaults (URL flags parsed in deps.ts, e.g. `?abr=40000&ns=0`). Every field
 * is optional; absent = the data-driven default. Never set in production URLs.
 */
export interface AudioTuning {
  /** Opus send bitrate (bps) in voice mode (`?abr=`). */
  voiceBitrate?: number;
  /** Opus send bitrate (bps) in music mode (`?mabr=`). */
  musicBitrate?: number;
  /** Voice-mode browser noise suppression (`?ns=0|1`). Music mode is always off. */
  ns?: boolean;
  /** Voice-mode browser auto gain control (`?agc=0|1`). Music mode is always off. */
  agc?: boolean;
  /**
   * Echo cancellation in both modes (`?ec=0|1`). Diagnostic only: in the lab both peers send the SAME corpus, so AEC
   * sees a far-end signal correlated with the near end and suppresses it — `ec=0` measures that artifact.
   */
  ec?: boolean;
  /** Opus DTX in voice mode (`?dtx=0|1`). Music mode is always off. */
  dtx?: boolean;
  /** Opus in-band FEC (`?fec=0|1`). */
  fec?: boolean;
  /**
   * Music mode negotiates `stereo=1;sprop-stereo=1` by default; `?mstereo=0` forces mono (lab comparison). libwebrtc
   * runs Opus in VOIP application mode for mono and AUDIO (music) mode only for stereo.
   */
  musicStereo?: boolean;
}

export function audioConstraints(mode: AudioMode, tuning: AudioTuning = {}): MediaTrackConstraints {
  // Music mode keeps echo cancellation ON (plan "Media details (B)"); the UI suggests headphones.
  return mode === "voice"
    ? {
        echoCancellation: tuning.ec ?? true,
        noiseSuppression: tuning.ns ?? true,
        autoGainControl: tuning.agc ?? true,
        channelCount: 1,
      }
    : {
        echoCancellation: tuning.ec ?? true,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      };
}

export function videoConstraints(facing: Facing): MediaTrackConstraints {
  return {
    facingMode: facing,
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
  };
}

export type MediaErrorKind = "permission-denied" | "no-devices" | "unsupported";

export function classifyMediaError(e: unknown): MediaErrorKind {
  const n = (e as { name?: string } | null)?.name ?? "";
  if (n === "NotAllowedError" || n === "SecurityError" || n === "PermissionDeniedError")
    return "permission-denied";
  if (n === "TypeError") return "unsupported";
  // NotFoundError, OverconstrainedError, NotReadableError (in use), AbortError, DevicesNotFoundError, …
  return "no-devices";
}

export interface LocalMediaState {
  audio: MediaStreamTrack | null;
  video: MediaStreamTrack | null;
  /** Preview stream; a new object whenever tracks change (so UI signals update). */
  stream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  mode: AudioMode;
  facing: Facing;
  micAvailable: boolean;
  camAvailable: boolean;
  canSwitchCamera: boolean;
  level: number;
  speaking: boolean;
  error: CallError | null;
}

/** May the engine ask for this kind alone after a combined request was refused? (Only if it is already granted.) */
export type RetryCheck = (kind: "audio" | "video") => boolean | Promise<boolean>;

export interface CaptureOptions {
  audio: boolean;
  video: boolean;
  /** Unmute the new mic / keep the new camera running (default true each). */
  turnOn?: { audio?: boolean; video?: boolean };
  /**
   * After a combined request is refused (NotAllowedError), whether to retry one kind alone to find out which device
   * is the problem. Absent → never (a second getUserMedia may show a second prompt for the same tap).
   */
  canRetrySeparately?: RetryCheck;
}

export interface CaptureResult {
  /** Error for the kinds asked for (null = all obtained). */
  error: CallError | null;
  audio: boolean;
  video: boolean;
  /** Kinds the browser/user refused (NotAllowedError & co.). */
  denied: ("audio" | "video")[];
}

export interface LocalMediaOptions {
  mediaDevices: MediaDevicesLike;
  MediaStream: typeof MediaStream;
  clock: Clock;
  log?: Logger;
  createAudioContext?: () => AudioContextLike | null;
  document?: DocumentLike;
  navigator?: { audioSession?: { type: string } };
  /** A track the transport must send changed (kind, new track or null). */
  onTrack?: (kind: "audio" | "video", track: MediaStreamTrack | null) => void;
  onChange?: () => void;
  meterIntervalMs?: number;
  /** Lab overrides of capture processing (NS/AGC). */
  audioTuning?: AudioTuning;
}

export class LocalMedia {
  readonly state: LocalMediaState = {
    audio: null,
    video: null,
    stream: null,
    micOn: true,
    camOn: true,
    mode: "voice",
    facing: "user",
    micAvailable: true,
    camAvailable: true,
    canSwitchCamera: false,
    level: 0,
    speaking: false,
    error: null,
  };
  private ctx: AudioContextLike | null = null;
  private meterSource: { disconnect(): void } | null = null;
  private analyser: ReturnType<AudioContextLike["createAnalyser"]> | null = null;
  private meterTimer: TimerHandle | undefined;
  private lastLoud = -Infinity;
  private busy: Promise<void> = Promise.resolve();
  private stopped = false;
  private listening = false;
  private recovering = new Set<"audio" | "video">();
  /** The user wants the camera on (button state); `state.camOn` additionally requires a live, unmuted track. */
  private camWanted = false;
  /** Kinds the browser has granted at least once (a later camera tap needs no new permission request). */
  private had = new Set<"audio" | "video">();
  private readonly log: Logger;

  constructor(private readonly o: LocalMediaOptions) {
    this.log = o.log ?? nullLogger;
  }

  get sourceShortSide(): number | undefined {
    const s = this.state.video?.getSettings?.();
    if (!s?.width || !s.height) return undefined;
    return Math.min(s.width, s.height);
  }

  /** Serialize all capture operations (two concurrent getUserMedia calls confuse iOS). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * Fresh capture (lobby): drops any current tracks, asks for the mic plus the camera unless `video: false`.
   * Resolves with the lobby error (if any); never rejects. A kind not asked for ends up unavailable (no track).
   */
  acquire(
    opts: { mode?: AudioMode; facing?: Facing; video?: boolean; canRetrySeparately?: RetryCheck } = {},
  ): Promise<CallError | null> {
    return this.exclusive(async () => {
      const st = this.state;
      st.mode = opts.mode ?? st.mode;
      st.facing = opts.facing ?? st.facing;
      st.micOn = true;
      this.stopTracks();
      const wantVideo = opts.video ?? true;
      const r = await this.captureNow({
        audio: true,
        video: wantVideo,
        ...(opts.canRetrySeparately ? { canRetrySeparately: opts.canRetrySeparately } : {}),
      });
      if (!wantVideo) {
        st.camAvailable = false;
        this.camWanted = false;
        this.syncCam();
        this.emit();
      }
      return r.error;
    });
  }

  /**
   * Capture the given kinds now, keeping the current track of every other kind (a late grant in a call: the new
   * track goes to the transport via `onTrack` → `replaceTrack`, no renegotiation). `turnOn` (default on) says
   * whether the new mic is unmuted / the new camera kept running — a late camera grant never turns the mic on.
   * Never rejects.
   */
  capture(opts: CaptureOptions): Promise<CaptureResult> {
    return this.exclusive(() => this.captureNow(opts));
  }

  /** A track of this kind was obtained at least once (the browser granted it). */
  everHad(kind: "audio" | "video"): boolean {
    return this.had.has(kind);
  }

  private async captureNow(opts: CaptureOptions): Promise<CaptureResult> {
    this.stopped = false;
    const st = this.state;
    const kinds = (["audio", "video"] as const).filter((k) => opts[k]);
    this.setAudioSession();
    this.listen();
    // iOS: release a device before asking for it again.
    for (const k of kinds) {
      try {
        st[k]?.stop();
      } catch {}
      st[k] = null;
    }
    const got: Record<"audio" | "video", MediaStreamTrack | null> = { audio: null, video: null };
    const errors: { kind: "audio" | "video"; e: unknown }[] = [];
    const constraints = (k: "audio" | "video") =>
      k === "audio" ? audioConstraints(st.mode, this.o.audioTuning) : videoConstraints(st.facing);
    if (kinds.length) {
      try {
        const s = await this.o.mediaDevices.getUserMedia({
          audio: opts.audio ? constraints("audio") : false,
          video: opts.video ? constraints("video") : false,
        });
        got.audio = opts.audio ? (s.getAudioTracks()[0] ?? null) : null;
        got.video = opts.video ? (s.getVideoTracks()[0] ?? null) : null;
        // Stray tracks we did not ask for (never expected) must not keep a device open.
        for (const t of s.getTracks?.() ?? []) if (t !== got.audio && t !== got.video) t.stop();
      } catch (e) {
        const refused = classifyMediaError(e) === "permission-denied";
        if (kinds.length === 1) errors.push({ kind: kinds[0]!, e });
        else {
          this.log.warn("getUserMedia(a+v) failed", { ...errInfo(e), refused });
          // Find out which device is the problem — but after a refusal only for a device the browser reports as
          // granted: one tap must never cause two prompts (Chrome auto-blocks after 3 dismissals).
          for (const k of kinds) {
            if (refused && !(await this.allowRetry(opts.canRetrySeparately, k))) {
              errors.push({ kind: k, e });
              continue;
            }
            try {
              const s = await this.o.mediaDevices.getUserMedia({ [k]: constraints(k) });
              got[k] = (k === "audio" ? s.getAudioTracks() : s.getVideoTracks())[0] ?? null;
            } catch (ek) {
              errors.push({ kind: k, e: ek });
            }
          }
        }
      }
    }
    if (this.stopped) {
      // stop() raced the prompt: release what we just got.
      for (const t of [got.audio, got.video]) t?.stop();
      return { error: null, audio: false, video: false, denied: [] };
    }
    const on = { audio: opts.turnOn?.audio ?? true, video: opts.turnOn?.video ?? true };
    if (opts.audio) {
      const a = got.audio;
      st.audio = a;
      st.micAvailable = !!a;
      st.micOn = !!a && on.audio;
      if (a) {
        a.enabled = st.micOn;
        this.had.add("audio");
        this.watchTrack(a);
      }
    }
    if (opts.video) {
      let v = got.video;
      if (v) this.had.add("video");
      if (v && !on.video) {
        v.stop(); // granted, but the user did not ask for the camera to run
        v = null;
      }
      st.video = v;
      st.camAvailable = !!got.video;
      this.camWanted = !!v;
      if (v) this.watchTrack(v);
    }
    if (!opts.video && !st.video && !this.had.has("video")) {
      // Sound only: the camera was not asked for, so it is not available (the camera button asks for it).
      st.camAvailable = false;
      this.camWanted = false;
    }
    this.syncCam();
    const classes = errors.map((x) => classifyMediaError(x.e));
    st.error =
      errors.length === 0
        ? null
        : {
            code: classes.includes("permission-denied") ? "permission-denied" : "no-devices",
            detail: errors.map((x) => `${x.kind}:${(x.e as { name?: string })?.name ?? "Error"}`).join(","),
          };
    this.rebuildStream();
    for (const k of kinds) this.o.onTrack?.(k, st[k]);
    await this.refreshDevices();
    if (opts.audio) this.startMeter();
    this.log.info("acquired", {
      ...(opts.audio ? { audio: !!st.audio } : {}),
      ...(opts.video ? { video: !!got.video } : {}),
      mode: st.mode,
      ...(st.error ? { code: st.error.code, detail: st.error.detail } : {}),
    });
    this.emit();
    return {
      error: st.error,
      audio: !!got.audio,
      video: !!got.video,
      denied: errors.filter((x) => classifyMediaError(x.e) === "permission-denied").map((x) => x.kind),
    };
  }

  private async allowRetry(check: RetryCheck | undefined, kind: "audio" | "video"): Promise<boolean> {
    if (!check) return false;
    try {
      return await check(kind);
    } catch {
      return false;
    }
  }

  setMic(on: boolean): void {
    const st = this.state;
    st.micOn = on && !!st.audio;
    if (st.audio) st.audio.enabled = st.micOn;
    if (!st.micOn) {
      st.level = 0;
      st.speaking = false;
    }
    this.log.info("mic", { on: st.micOn });
    this.emit();
  }

  setCam(on: boolean): Promise<void> {
    return this.exclusive(async () => {
      const st = this.state;
      if (!on) {
        this.camWanted = false;
        if (st.video) {
          st.video.stop(); // camera light off
          st.video = null;
          this.o.onTrack?.("video", null);
        }
        st.camOn = false;
        this.rebuildStream();
        this.log.info("cam", { on: false });
        this.emit();
        return;
      }
      if (st.video && st.video.readyState === "live" && !st.video.muted) {
        this.camWanted = true;
        this.syncCam();
        this.emit();
        return;
      }
      // None, ended, or silenced by the browser: the user asks for the camera, so (re)capture it.
      try {
        st.video?.stop(); // iOS: release before re-acquiring
      } catch {}
      st.video = null;
      const track = await this.getTrack("video");
      st.video = track;
      this.camWanted = !!track;
      this.syncCam();
      if (track) {
        st.camAvailable = true;
        if (st.error?.detail?.startsWith("video") && st.audio) st.error = null;
      }
      this.rebuildStream();
      this.o.onTrack?.("video", track);
      this.log.info("cam", { on: st.camOn });
      this.emit();
    });
  }

  switchCamera(): Promise<void> {
    return this.exclusive(async () => {
      const st = this.state;
      const next: Facing = st.facing === "user" ? "environment" : "user";
      if (!this.camWanted) {
        st.facing = next;
        this.emit();
        return;
      }
      st.video?.stop(); // iOS: release the camera before asking for the other one
      st.video = null;
      let track = await this.getTrack("video", next);
      if (track) st.facing = next;
      else track = await this.getTrack("video"); // fall back to the old facing
      st.video = track;
      this.camWanted = !!track;
      this.syncCam();
      this.rebuildStream();
      this.o.onTrack?.("video", track);
      this.log.info("camera switched", { facing: st.facing, ok: !!track });
      this.emit();
    });
  }

  setMode(mode: AudioMode): Promise<void> {
    return this.exclusive(async () => {
      const st = this.state;
      if (st.mode === mode && st.audio) return;
      st.mode = mode;
      if (!this.had.has("audio")) {
        // Mic never granted: the next capture uses the new mode; asking now would be a prompt nobody tapped for.
        this.emit();
        return;
      }
      if (st.audio) {
        st.audio.stop(); // iOS: stop before re-acquire
        st.audio = null;
      }
      const track = await this.getTrack("audio");
      st.audio = track;
      if (track) track.enabled = st.micOn;
      else st.micOn = false;
      this.rebuildStream();
      this.o.onTrack?.("audio", track);
      this.startMeter();
      this.log.info("mode", { mode, ok: !!track });
      this.emit();
    });
  }

  /** Resume the meter's AudioContext from a user gesture (Join). */
  async resumeAudioContext(): Promise<void> {
    try {
      if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume();
    } catch {}
  }

  stop(): void {
    this.stopped = true;
    this.stopTracks();
    this.stopMeter();
    try {
      void this.ctx?.close();
    } catch {}
    this.ctx = null;
    this.unlisten();
    this.state.stream = null;
    this.state.level = 0;
    this.state.speaking = false;
  }

  // ── internals ──

  private async getTrack(
    kind: "audio" | "video",
    facing = this.state.facing,
  ): Promise<MediaStreamTrack | null> {
    try {
      const s = await this.o.mediaDevices.getUserMedia(
        kind === "audio"
          ? { audio: audioConstraints(this.state.mode, this.o.audioTuning) }
          : { video: videoConstraints(facing) },
      );
      const t = (kind === "audio" ? s.getAudioTracks() : s.getVideoTracks())[0] ?? null;
      if (t) {
        this.had.add(kind);
        this.watchTrack(t);
      }
      return t;
    } catch (e) {
      this.log.warn("getUserMedia failed", { kind, ...errInfo(e) });
      return null;
    }
  }

  private stopTracks() {
    for (const t of [this.state.audio, this.state.video]) {
      try {
        t?.stop();
      } catch {}
    }
    this.state.audio = null;
    this.state.video = null;
  }

  private rebuildStream() {
    const tracks = [this.state.audio, this.state.video].filter((t): t is MediaStreamTrack => !!t);
    this.state.stream = new this.o.MediaStream(tracks);
  }

  private emit() {
    if (!this.stopped) this.o.onChange?.();
  }

  private setAudioSession() {
    const s = this.o.navigator?.audioSession;
    if (!s) return;
    try {
      s.type = "play-and-record";
    } catch {}
  }

  /** `camOn` = wanted AND the current track really delivers frames (live, not muted by the browser). */
  private syncCam(): boolean {
    const v = this.state.video;
    const on = this.camWanted && !!v && v.readyState === "live" && !v.muted;
    if (on === this.state.camOn) return false;
    this.state.camOn = on;
    return true;
  }

  private watchTrack(t: MediaStreamTrack) {
    const current = () => {
      const st = this.state;
      return !this.stopped && (t.kind === "audio" ? st.audio : st.video) === t;
    };
    t.addEventListener?.("ended", () => {
      if (!current()) return;
      const kind = t.kind as "audio" | "video";
      this.log.warn("track ended", { kind });
      if (kind === "video" && this.syncCam()) this.emit();
      void this.recover(kind);
    });
    if (t.kind !== "video") return;
    // The browser silences capture without ending it (WebKit: another page took the camera; iOS: backgrounded).
    // Peers must see camera-off instead of a frozen/black tile; frames resume on `unmute`.
    for (const type of ["mute", "unmute"] as const) {
      t.addEventListener?.(type, () => {
        if (!current()) return;
        this.log.info(`camera ${type}d by the browser`, { camOn: this.camWanted && type === "unmute" });
        if (this.syncCam()) this.emit();
      });
    }
  }

  /** Re-acquire a lost track if it should be live (iOS background, device unplugged). */
  private recover(kind: "audio" | "video"): Promise<void> {
    if (this.recovering.has(kind)) return Promise.resolve();
    if (this.o.document && this.o.document.visibilityState !== "visible") return Promise.resolve(); // on visible
    this.recovering.add(kind);
    return this.exclusive(async () => {
      try {
        const st = this.state;
        // Never re-ask for a device the browser has not granted yet: that would be a prompt without a tap.
        const want = this.had.has(kind) && (kind === "audio" ? st.micAvailable : this.camWanted);
        const cur = kind === "audio" ? st.audio : st.video;
        if (!want || this.stopped) return;
        if (cur && cur.readyState === "live" && !cur.muted) return;
        try {
          cur?.stop();
        } catch {}
        const track = await this.getTrack(kind);
        if (kind === "audio") {
          st.audio = track;
          if (track) track.enabled = st.micOn;
        } else {
          st.video = track;
          this.camWanted = !!track;
          this.syncCam();
        }
        this.rebuildStream();
        this.o.onTrack?.(kind, track);
        if (kind === "audio") this.startMeter();
        this.log.info("track recovered", { kind, ok: !!track });
        this.emit();
      } finally {
        this.recovering.delete(kind);
      }
    });
  }

  private onVisibility = () => {
    if (this.o.document?.visibilityState !== "visible" || this.stopped) return;
    const st = this.state;
    for (const kind of ["audio", "video"] as const) {
      const t = kind === "audio" ? st.audio : st.video;
      const want = this.had.has(kind) && (kind === "audio" ? st.micAvailable && !!st.stream : this.camWanted);
      if (want && (!t || t.readyState === "ended" || t.muted)) void this.recover(kind);
    }
    void this.resumeAudioContext();
  };

  private onDeviceChange = () => {
    if (this.stopped) return;
    this.log.info("devicechange");
    void this.refreshDevices().then(() => {
      this.onVisibility();
      this.emit();
    });
  };

  private listen() {
    if (this.listening) return;
    this.listening = true;
    this.o.document?.addEventListener("visibilitychange", this.onVisibility);
    this.o.mediaDevices.addEventListener?.("devicechange", this.onDeviceChange);
  }

  private unlisten() {
    if (!this.listening) return;
    this.listening = false;
    this.o.document?.removeEventListener("visibilitychange", this.onVisibility);
    this.o.mediaDevices.removeEventListener?.("devicechange", this.onDeviceChange);
  }

  private async refreshDevices() {
    try {
      const list = (await this.o.mediaDevices.enumerateDevices?.()) ?? [];
      this.state.canSwitchCamera = list.filter((d) => d.kind === "videoinput").length > 1;
    } catch {
      this.state.canSwitchCamera = false;
    }
  }

  // ── level meter (local only: one AudioContext + AnalyserNode) ──

  private startMeter() {
    this.stopMeter();
    const track = this.state.audio;
    if (!track || !this.o.createAudioContext) return;
    try {
      this.ctx ??= this.o.createAudioContext();
      if (!this.ctx) return;
      const src = this.ctx.createMediaStreamSource(new this.o.MediaStream([track]));
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      this.meterSource = src;
      this.analyser = an;
    } catch (e) {
      this.log.debug("meter unavailable", errInfo(e));
      return;
    }
    const buf = new Float32Array(512);
    this.meterTimer = this.o.clock.setInterval(() => {
      const st = this.state;
      if (!this.analyser || !st.micOn) {
        if (st.level !== 0 || st.speaking) {
          st.level = 0;
          st.speaking = false;
          this.emit();
        }
        return;
      }
      this.analyser.getFloatTimeDomainData(buf);
      const level = meterLevel(buf, st.level);
      const now = this.o.clock.now();
      if (level > 0.08) this.lastLoud = now;
      const speaking = now - this.lastLoud < 500;
      if (Math.abs(level - st.level) > 0.01 || speaking !== st.speaking) {
        st.level = level;
        st.speaking = speaking;
        this.emit();
      }
    }, this.o.meterIntervalMs ?? 100);
  }

  private stopMeter() {
    this.o.clock.clearInterval(this.meterTimer);
    this.meterTimer = undefined;
    try {
      this.meterSource?.disconnect();
    } catch {}
    this.meterSource = null;
    this.analyser = null;
  }
}

/** RMS of a time-domain block → perceptual 0..1 level with fast attack / slow release. */
export function meterLevel(samples: Float32Array, prev: number): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  // Map −60 dBFS..0 dBFS to 0..1.
  const db = rms > 0 ? 20 * Math.log10(rms) : -100;
  const target = Math.max(0, Math.min(1, (db + 60) / 60));
  const next = target >= prev ? target : prev * 0.8 + target * 0.2;
  return Math.round(next * 1000) / 1000;
}
