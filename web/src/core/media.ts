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

export function audioConstraints(mode: AudioMode): MediaTrackConstraints {
  // Music mode keeps echo cancellation ON (plan "Media details (B)"); the UI suggests headphones.
  return mode === "voice"
    ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    : { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
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
  private camWanted = true;
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

  /** Initial capture for the lobby. Resolves with the lobby error (if any); never rejects. */
  acquire(opts: { mode?: AudioMode; facing?: Facing; video?: boolean } = {}): Promise<CallError | null> {
    return this.exclusive(async () => {
      this.stopped = false;
      const st = this.state;
      st.mode = opts.mode ?? st.mode;
      st.facing = opts.facing ?? st.facing;
      const wantVideo = opts.video ?? true;
      this.setAudioSession();
      this.listen();
      this.stopTracks();
      let audio: MediaStreamTrack | null = null;
      let video: MediaStreamTrack | null = null;
      const errors: { kind: "audio" | "video"; e: unknown }[] = [];
      try {
        const s = await this.o.mediaDevices.getUserMedia({
          audio: audioConstraints(st.mode),
          video: wantVideo ? videoConstraints(st.facing) : false,
        });
        audio = s.getAudioTracks()[0] ?? null;
        video = s.getVideoTracks()[0] ?? null;
      } catch (e) {
        this.log.warn("getUserMedia(a+v) failed, trying separately", errInfo(e));
        // Find out which device is the problem.
        try {
          audio =
            (
              await this.o.mediaDevices.getUserMedia({ audio: audioConstraints(st.mode) })
            ).getAudioTracks()[0] ?? null;
        } catch (ea) {
          errors.push({ kind: "audio", e: ea });
        }
        if (wantVideo) {
          try {
            video =
              (
                await this.o.mediaDevices.getUserMedia({ video: videoConstraints(st.facing) })
              ).getVideoTracks()[0] ?? null;
          } catch (ev) {
            errors.push({ kind: "video", e: ev });
          }
        }
      }
      st.audio = audio;
      st.video = video;
      st.micAvailable = !!audio || !errors.some((x) => x.kind === "audio");
      st.camAvailable = !!video || !errors.some((x) => x.kind === "video");
      if (!audio) st.micAvailable = false;
      if (wantVideo && !video) st.camAvailable = false;
      st.micOn = !!audio && st.micOn;
      if (audio) audio.enabled = st.micOn;
      this.camWanted = !!video;
      this.syncCam();
      const kinds = errors.map((x) => classifyMediaError(x.e));
      st.error =
        errors.length === 0
          ? null
          : {
              code: kinds.includes("permission-denied") ? "permission-denied" : "no-devices",
              detail: errors.map((x) => `${x.kind}:${(x.e as { name?: string })?.name ?? "Error"}`).join(","),
            };
      for (const t of [audio, video]) if (t) this.watchTrack(t);
      this.rebuildStream();
      await this.refreshDevices();
      this.startMeter();
      this.log.info("acquired", {
        audio: !!audio,
        video: !!video,
        mode: st.mode,
        ...(st.error ? { code: st.error.code, detail: st.error.detail } : {}),
      });
      this.emit();
      return st.error;
    });
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
        kind === "audio" ? { audio: audioConstraints(this.state.mode) } : { video: videoConstraints(facing) },
      );
      const t = (kind === "audio" ? s.getAudioTracks() : s.getVideoTracks())[0] ?? null;
      if (t) this.watchTrack(t);
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
        const want = kind === "audio" ? st.micAvailable : this.camWanted;
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
      const want = kind === "audio" ? st.micAvailable && !!st.stream : this.camWanted;
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
