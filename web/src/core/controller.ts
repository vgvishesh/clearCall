/**
 * The real call engine: `createCallController(deps?)` implements `CallController` (types.ts).
 *
 * Phases: idle → lobby → joining → in-call ⇄ reconnecting → ended | error (see types.ts for semantics).
 * Owns: link/keys, local media, the signaling client, the media transport (mesh), remote <audio> playback +
 * `audioBlocked`, active speaker, wake lock, stats sampler, telemetry and (with ?qa=1) `window.__clearcall`.
 */

import { buildCallLink, MAX_NAME_LENGTH, parseCallLink, type RoomKeys } from "@clearcall/protocol";
import { batch, signal } from "@preact/signals";
import { SpeakerTracker } from "./active-speaker.ts";
import { RemoteAudio } from "./audio-out.ts";
import type { TimerHandle } from "./clock.ts";
import {
  chooseVideoCodecOrder,
  constrainedDevice,
  forcedVideoOrder,
  heavyExclusions,
  untrustedPowerEfficient,
} from "./codecs.ts";
import { CPU_LEVEL_NAMES, type CpuLevel } from "./cpu-guard.ts";
import { type CoreDeps, defaultDeps, type WakeLockLike } from "./deps.ts";
import { createLog, errInfo, type LogSink, short } from "./log.ts";
import { type CaptureOptions, LocalMedia } from "./media.ts";
import { browserClass, DevicePermissions, type MediaKind, type PermSnapshot } from "./permissions.ts";
import { createQaHook, installQaHook } from "./qa.ts";
import { type FatalSignalingCode, roomUrl, SignalingClient } from "./signaling-client.ts";
import { StatsSampler } from "./stats.ts";
import { startTelemetry, type Telemetry } from "./telemetry.ts";
import { MeshTransport } from "./transport/mesh.ts";
import type { LocalAnnounce, MediaTransport } from "./transport/types.ts";
import type {
  AudioMode,
  CallController,
  CallError,
  CallErrorCode,
  CallPhase,
  CallState,
  LocalParticipant,
  MediaRequest,
  QaHook,
  RemoteParticipant,
} from "./types.ts";

export const NAME_STORAGE_KEY = "clearcall.name";
const LEVEL_POLL_MS = 200;

const initialLocal = (name = ""): LocalParticipant => ({
  name,
  micOn: true,
  camOn: true,
  mode: "voice",
  facing: "user",
  stream: null,
  audioLevel: 0,
  speaking: false,
  canSwitchCamera: false,
  camAvailable: true,
  micAvailable: true,
  mediaRequest: "done",
});

const initialState = (name = ""): CallState => ({
  phase: "idle",
  error: null,
  link: null,
  local: initialLocal(name),
  participants: [],
  activeSpeakerId: null,
  audioBlocked: false,
  joinedAt: null,
  endedAt: null,
  videoLimited: null,
});

/** Map a fatal signaling outcome to the UI error code. */
export function fatalToError(code: FatalSignalingCode): CallErrorCode | null {
  switch (code) {
    case "room-full":
      return "room-full";
    case "version":
      return "version-mismatch";
    case "replaced":
      return null;
    default:
      return "signaling-unavailable";
  }
}

export interface CallControllerInternals {
  readonly log: LogSink;
  readonly transport: MediaTransport | null;
  readonly signaling: SignalingClient | null;
  readonly qa: QaHook;
  readonly peerId: string | null;
}

class Controller implements CallController {
  readonly state = signal<CallState>(initialState());
  readonly log: LogSink;
  readonly qa: QaHook;
  private readonly d: CoreDeps;
  private readonly L;
  private keys: RoomKeys | null = null;
  private media: LocalMedia | null = null;
  /** Pending camera/mic capture; `join()` waits for it so the first offer carries real tracks. */
  private mediaReady: Promise<void> | null = null;
  /** `prepare()` in progress (a `requestMedia()` from the same tap waits for it). */
  private preparing: Promise<void> | null = null;
  private perms: DevicePermissions | null = null;
  /**
   * Kinds whose last request was refused → whether to turn them on when the browser later reports them granted
   * (auto re-acquire after Settings; never a prompt).
   */
  private denied = new Map<MediaKind, boolean>();
  private autoBusy = false;
  private autoAgain = false;
  private readonly browser: string;
  transport: MediaTransport | null = null;
  signaling: SignalingClient | null = null;
  peerId: string | null = null;
  private remoteAudio: RemoteAudio;
  private speaker = new SpeakerTracker();
  private sampler: StatsSampler;
  private levelTimer: TimerHandle | undefined;
  private wakeLock: WakeLockLike | null = null;
  private wantWakeLock = false;
  private videoOrder: Promise<string[] | null> | null = null;
  private telemetry: Telemetry | null = null;
  private uninstallQa: (() => void) | null = null;
  private lobbyId: string;
  private generation = 0;
  private everInCall = false;
  private disposed = false;
  private unsubTransport: (() => void) | null = null;
  /** Welcome received while joining; entering the call once the transport has resolved the roster. */
  private awaitingRoster = false;

  constructor(deps: CoreDeps) {
    this.d = deps;
    this.log = createLog({ now: deps.clock.now, consoleLevel: deps.flags.debug ? "debug" : "warn" });
    this.L = this.log.scope("controller");
    this.lobbyId = `lobby-${Math.floor(deps.random() * 1e9).toString(36)}`;
    this.browser = browserClass(deps.userAgent);
    const stored = this.readName();
    this.state.value = initialState(stored);
    this.remoteAudio = new RemoteAudio({
      createElement: deps.createAudioElement,
      log: this.log.scope("audio"),
      onBlocked: (blocked) => this.patch({ audioBlocked: blocked }),
    });
    this.sampler = new StatsSampler({
      clock: deps.clock,
      collect: () => this.transport?.stats("sampler") ?? Promise.resolve([]),
      log: this.log.scope("stats"),
      PerformanceObserver: deps.PerformanceObserver,
      performance: deps.performance,
    });
    this.qa = createQaHook({
      state: () => this.state.value,
      stats: () => this.transport?.stats("qa") ?? Promise.resolve([]),
      timeline: () => this.sampler.timeline(),
      logs: () => this.log.entries(),
      transport: () => this.transport?.kind ?? "mesh",
      dropSignaling: () => this.signaling?.drop(),
      restartIce: (id) => this.transport?.restartIce(id),
      killPeer: (id) => this.transport?.kill(id),
      simulateCpuOverload: () => this.transport?.simulateCpuOverload(),
      MediaRecorder: deps.MediaRecorder,
      log: this.log.scope("qa"),
    });
    if (deps.flags.qa && deps.qaTarget) this.uninstallQa = installQaHook(deps.qaTarget, this.qa);
    if (deps.flags.telemetry && deps.fetch) {
      this.telemetry = startTelemetry({
        fetch: deps.fetch,
        ...(deps.navigator.sendBeacon ? { sendBeacon: deps.navigator.sendBeacon } : {}),
        clock: deps.clock,
        log: this.log,
        peer: () => this.peerId ?? this.lobbyId,
        samples: () => this.sampler.timeline(),
      });
    }
    deps.window?.addEventListener("pagehide", this.onPageHide);
    deps.window?.addEventListener("online", this.onOnline);
    deps.document?.addEventListener("visibilitychange", this.onVisibility);
    this.L.info("controller created", { qa: deps.flags.qa, red: deps.flags.red, audio: deps.flags.audio });
    if (
      deps.flags.vcodec ||
      deps.flags.vstart !== undefined ||
      deps.flags.vlevel ||
      deps.flags.vmin !== undefined ||
      deps.flags.vmax !== undefined ||
      deps.flags.jbt !== undefined ||
      deps.flags.svc
    )
      this.L.info("video lab overrides", {
        vcodec: deps.flags.vcodec,
        vstart: deps.flags.vstart,
        vlevel: deps.flags.vlevel,
        vmin: deps.flags.vmin,
        vmax: deps.flags.vmax,
        jbt: deps.flags.jbt,
        svc: deps.flags.svc,
      });
  }

  // ── state helpers ──

  private patch(p: Partial<CallState>) {
    this.state.value = { ...this.state.value, ...p };
  }

  private patchLocal(p: Partial<LocalParticipant>) {
    this.patch({ local: { ...this.state.value.local, ...p } });
  }

  private setPhase(phase: CallPhase, extra: Partial<CallState> = {}) {
    const prev = this.state.value.phase;
    if (prev !== phase)
      this.L.info("phase", { from: prev, to: phase, ...(extra.error ? { code: extra.error.code } : {}) });
    this.patch({ phase, ...extra });
  }

  private syncLocalFromMedia() {
    const m = this.media?.state;
    if (!m) return;
    this.patchLocal({
      micOn: m.micOn,
      camOn: m.camOn,
      mode: m.mode,
      facing: m.facing,
      stream: m.stream,
      audioLevel: m.level,
      speaking: m.speaking,
      canSwitchCamera: m.canSwitchCamera,
      camAvailable: m.camAvailable,
      micAvailable: m.micAvailable,
    });
  }

  private announce(): LocalAnnounce {
    const l = this.state.value.local;
    // Video paused by the CPU guard: tell peers the camera is off so they show our avatar, not a frozen frame.
    const cam = l.camOn && this.state.value.videoLimited !== "paused";
    return { name: l.name, mic: l.micOn, cam, mode: l.mode };
  }

  /**
   * Software AV1/VP9 to leave out of every negotiation (ADR-0010): on a constrained device (phone, ≤ 2 cores,
   * ≤ 4 GB), unless the browser encodes them in hardware. A lab-forced codec (`?vcodec=`) is never excluded.
   */
  private videoExclusions(videoOrder: string[] | null): string[] {
    const d = this.d;
    if (d.flags.vcodec) return [];
    const why =
      d.flags.devclass === "constrained"
        ? "flag"
        : d.flags.devclass === "normal"
          ? null
          : constrainedDevice({ userAgent: d.userAgent, cores: d.device.cores, memoryGb: d.device.memoryGb });
    if (!why) return [];
    const ex = heavyExclusions(videoOrder);
    this.L.info("constrained device: no software AV1/VP9", { why, exclude: ex, ...d.device });
    return ex;
  }

  private onCpuLevel(level: CpuLevel) {
    const videoLimited = level === 2 ? "paused" : level === 1 ? "reduced" : null;
    if (this.state.value.videoLimited === videoLimited) return;
    this.L.info("video limited", { level: CPU_LEVEL_NAMES[level] });
    this.patch({ videoLimited });
    this.transport?.setLocalState(this.announce());
  }

  private syncParticipants() {
    const t = this.transport;
    if (!t) return;
    const prev = new Map(this.state.value.participants.map((p) => [p.id, p]));
    const participants: RemoteParticipant[] = t.participants().map((r) => ({
      ...r,
      audioLevel: prev.get(r.id)?.audioLevel ?? 0,
      speaking: prev.get(r.id)?.speaking ?? false,
    }));
    const activeSpeakerId =
      this.state.value.activeSpeakerId && participants.some((p) => p.id === this.state.value.activeSpeakerId)
        ? this.state.value.activeSpeakerId
        : null;
    this.patch({ participants, activeSpeakerId });
    this.remoteAudio.sync(participants);
  }

  private readName(): string {
    try {
      return (this.d.storage?.getItem(NAME_STORAGE_KEY) ?? "").slice(0, MAX_NAME_LENGTH);
    } catch {
      return "";
    }
  }

  // ── CallController ──

  prepare(opts: { link?: string; name?: string }): Promise<void> {
    const done: Promise<void> = this.prepareNow(opts).finally(() => {
      if (this.preparing === done) this.preparing = null;
    });
    this.preparing = done;
    return done;
  }

  private async prepareNow(opts: { link?: string; name?: string }): Promise<void> {
    if (this.disposed) return;
    this.teardown({ bye: true });
    const gen = ++this.generation;
    const d = this.d;
    this.everInCall = false;
    const name = (opts.name ?? this.state.value.local.name ?? this.readName()).slice(0, MAX_NAME_LENGTH);
    this.state.value = initialState(name);
    if (opts.name !== undefined) this.setName(opts.name);

    const missing = [
      !d.RTCPeerConnection && "RTCPeerConnection",
      !d.MediaStream && "MediaStream",
      !d.mediaDevices?.getUserMedia && "getUserMedia",
      !d.crypto.available && "WebCrypto",
      !d.WebSocket && "WebSocket",
      !d.isSecureContext && "secure-context",
    ].filter(Boolean);
    if (missing.length) {
      this.setPhase("error", { error: { code: "unsupported", detail: missing.join(",") } });
      return;
    }

    let secret: string | null;
    if (opts.link === undefined) secret = d.crypto.generateSecret();
    else secret = parseCallLink(opts.link);
    if (!secret) {
      this.setPhase("error", { error: { code: "invalid-link" } });
      return;
    }
    try {
      d.history?.replaceState(null, "", `/c#${secret}`);
    } catch (e) {
      this.L.warn("replaceState failed", errInfo(e));
    }
    const link = buildCallLink(d.location.origin, secret);

    // Ask the browser what it already decided about camera/mic, in parallel with the key derivation. The lobby
    // appears once both are known, so it never flashes the wrong camera/mic step.
    const perms = new DevicePermissions({
      permissions: d.permissions,
      clock: d.clock,
      log: this.log.scope("media"),
      timeoutMs: 500,
      onChange: (kind, st) => {
        if (this.perms !== perms) return;
        this.L.info("permission changed", { kind, state: st });
        if (st === "granted") void this.autoReacquire("change");
      },
    });
    this.perms = perms;
    const permQuery = perms.query();
    try {
      this.keys = await d.crypto.deriveRoomKeys(secret);
    } catch (e) {
      if (gen !== this.generation) return;
      this.setPhase("error", { error: { code: "unsupported", detail: `crypto:${errInfo(e).err}` } });
      return;
    }
    const perm = await permQuery;
    if (gen !== this.generation) return;

    const forced = forcedVideoOrder(d.flags.vcodec); // lab bake-off only (`?vcodec=`)
    this.videoOrder ??= forced
      ? Promise.resolve(forced)
      : chooseVideoCodecOrder(
          d.getCapabilities("video")?.codecs,
          d.mediaCapabilities,
          this.log.scope("codecs"),
          undefined,
          untrustedPowerEfficient(d.userAgent),
        );

    this.media = new LocalMedia({
      mediaDevices: d.mediaDevices!,
      MediaStream: d.MediaStream!,
      clock: d.clock,
      log: this.log.scope("media"),
      ...(d.createAudioContext ? { createAudioContext: d.createAudioContext } : {}),
      ...(d.document ? { document: d.document } : {}),
      navigator: d.navigator,
      ...(d.flags.audio ? { audioTuning: d.flags.audio } : {}),
      // Initial, late (a listen-only joiner taps Allow) and recovered tracks all reach every pair via replaceTrack.
      onTrack: (kind, track) => this.transport?.setLocalTrack(kind, track),
      onChange: () => {
        this.syncLocalFromMedia();
        this.transport?.setLocalState(this.announce());
      },
    });
    const media = this.media;
    this.L.info("permissions", { audio: perm.audio, video: perm.video, browser: this.browser });

    if (perm.audio === "granted" && perm.video === "granted") {
      // Already allowed (returning visitor, quality lab, E2E): no prompt can appear, so capture at once.
      // mediaRequest stays "done" (no "tap Allow" hint); the preview fills in when the tracks arrive.
      this.setPhase("lobby", { link, error: null });
      await this.runCapture({ audio: true, video: true }, "granted");
      return;
    }
    // Nothing captured yet: mic and camera are off until a tap gets them granted.
    Object.assign(media.state, { micOn: false, camOn: false });
    if (perm.audio === "denied" || perm.video === "denied") {
      // Blocked before: getUserMedia would fail without a prompt — go straight to the help steps.
      for (const k of ["audio", "video"] as const) if (perm[k] === "denied") this.denied.set(k, true);
      Object.assign(media.state, {
        micAvailable: perm.audio !== "denied",
        camAvailable: perm.video !== "denied",
      });
      this.syncLocalFromMedia();
      this.setPhase("lobby", { link, error: { code: "permission-denied", detail: "permissions-api" } });
      this.setMediaRequest("done", "prepare-denied", { audio: perm.audio, video: perm.video });
      return;
    }
    this.syncLocalFromMedia();
    this.setPhase("lobby", { link, error: null });
    this.setMediaRequest("not-asked", "prepare");
  }

  async requestMedia(opts: { video?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    // "Start a call" may call prepare() and requestMedia() back to back from one tap.
    if (this.preparing) await this.preparing;
    const media = this.media;
    const s = this.state.value;
    if (!media || !(s.phase === "lobby" || this.inCallish())) {
      this.L.warn("requestMedia ignored", { phase: s.phase });
      return;
    }
    if (s.local.mediaRequest === "asking") return; // the prompt is already up
    const video = opts.video !== false;
    const live = (t: MediaStreamTrack | null) => !!t && t.readyState !== "ended";
    const want = { audio: !live(media.state.audio), video: video && !live(media.state.video) };
    // Sound only: the user chose no camera — never bring it back by itself.
    if (!video) this.denied.delete("video");
    // In a call the tap was on one button: a late camera grant never unmutes the mic, and vice versa.
    const turnOn = this.inCallish() ? { audio: !video, video: true } : { audio: true, video: true };
    if (!want.audio && !want.video) {
      this.setMediaRequest("done", "tap-nothing-to-do");
      return;
    }
    await this.runCapture(want, "tap", turnOn);
  }

  /** The one place the controller starts getUserMedia (via LocalMedia.capture). */
  private async runCapture(
    want: { audio: boolean; video: boolean },
    why: "tap" | "granted" | "auto",
    turnOn?: CaptureOptions["turnOn"],
  ): Promise<void> {
    const media = this.media;
    if (!media) return;
    const gen = this.generation;
    if (why === "tap") this.setMediaRequest("asking", why, { audio: want.audio, video: want.video });
    const capture = media.capture({
      ...want,
      ...(turnOn ? { turnOn } : {}),
      // After a refused combined request, probe a single device only if the browser says it is granted.
      canRetrySeparately: async (k) => (await this.queryPerms())[k] === "granted",
    });
    const ready = capture.then(() => undefined);
    this.mediaReady = ready;
    const r = await capture;
    if (this.mediaReady === ready) this.mediaReady = null;
    if (gen !== this.generation || media !== this.media) return;
    for (const k of ["audio", "video"] as const) {
      if (!want[k]) continue;
      if (r.denied.includes(k)) this.denied.set(k, turnOn?.[k] ?? true);
      else this.denied.delete(k);
    }
    this.syncLocalFromMedia();
    if (this.state.value.phase === "lobby") {
      // A device still blocked from before (not part of this capture) keeps the blocked help on screen.
      const still = [...this.denied.keys()].filter((k) => !want[k]);
      this.patch({
        error:
          r.error ??
          (still.length
            ? { code: "permission-denied", detail: still.map((k) => `${k}:denied`).join(",") }
            : null),
      });
    }
    this.setMediaRequest("done", why, {
      audio: r.audio,
      video: r.video,
      ...(r.error ? { code: r.error.code, detail: r.error.detail } : {}),
    });
    this.transport?.setLocalState(this.announce());
    // iOS: the first capture switches the audio session to play-and-record, which can pause remote <audio>.
    if (r.audio && this.inCallish()) {
      this.L.info("mic granted in call: re-playing remote audio");
      void this.remoteAudio.resume();
    }
  }

  private queryPerms(): Promise<PermSnapshot> {
    return this.perms?.query() ?? Promise.resolve({ audio: "unknown", video: "unknown" });
  }

  /** QA log line on every request step (browser class only — never the UA string or the link). */
  private setMediaRequest(to: MediaRequest, why: string, data: Record<string, unknown> = {}) {
    const from = this.state.value.local.mediaRequest;
    this.L.info("mediaRequest", { from, to, why, browser: this.browser, ...data });
    if (from !== to) this.patchLocal({ mediaRequest: to });
  }

  /**
   * After a refusal, re-acquire by itself ONLY when the Permissions API now says "granted" (the user changed it in
   * Settings / site settings). Never a prompt; no Permissions API → nothing (the user taps "Try again").
   */
  private async autoReacquire(why: "change" | "visible"): Promise<void> {
    if (this.autoBusy) {
      this.autoAgain = true;
      return;
    }
    const perms = this.perms;
    if (!perms?.supported || !this.media || this.denied.size === 0) return;
    if (!(this.state.value.phase === "lobby" || this.inCallish())) return;
    if (this.state.value.local.mediaRequest !== "done") return;
    this.autoBusy = true;
    try {
      const gen = this.generation;
      const perm = await perms.query();
      if (gen !== this.generation || this.state.value.local.mediaRequest !== "done") return;
      const kinds = [...this.denied.keys()].filter((k) => perm[k] === "granted");
      if (!kinds.length) return;
      const lobby = this.state.value.phase === "lobby";
      const turnOn = {
        audio: lobby || (this.denied.get("audio") ?? false),
        video: lobby || (this.denied.get("video") ?? false),
      };
      this.L.info("permission granted: re-acquiring", { why, kinds });
      await this.runCapture(
        { audio: kinds.includes("audio"), video: kinds.includes("video") },
        "auto",
        turnOn,
      );
    } finally {
      this.autoBusy = false;
    }
    if (this.autoAgain) {
      this.autoAgain = false;
      await this.autoReacquire(why);
    }
  }

  async join(name: string): Promise<void> {
    const s = this.state.value;
    if (this.disposed || s.phase !== "lobby" || !this.keys) {
      this.L.warn("join ignored", { phase: s.phase });
      return;
    }
    const d = this.d;
    const gen = this.generation;
    this.setName(name);
    this.setPhase("joining", { error: null, videoLimited: null });
    void this.media?.resumeAudioContext();
    this.requestWakeLock();

    // Let a pending getUserMedia finish first (bounded: a permission prompt may sit open). Nothing pending (camera
    // and mic never asked for) → join listen-only at once; a later grant reaches every pair via replaceTrack.
    if (this.mediaReady) {
      const pending = this.mediaReady;
      const waited = await Promise.race([
        pending.then(() => true),
        new Promise<false>((r) => d.clock.setTimeout(() => r(false), 10_000)),
      ]);
      if (!waited) this.L.warn("joining before local media is ready", {});
      if (gen !== this.generation || this.state.value.phase !== "joining") return;
    }

    const videoOrder = await Promise.race([
      this.videoOrder ?? Promise.resolve(null),
      new Promise<null>((r) => d.clock.setTimeout(() => r(null), 500)),
    ]).catch(() => null);
    if (gen !== this.generation || this.state.value.phase !== "joining") return;

    const peerId = d.crypto.generatePeerId(); // new participant on every join (FLOWS §5)
    this.peerId = peerId;
    const media = this.media;
    const transport = new MeshTransport({
      selfId: peerId,
      RTCPeerConnection: d.RTCPeerConnection!,
      MediaStream: d.MediaStream!,
      clock: d.clock,
      sendSignal: (to, payload) => this.signaling?.send(to, payload),
      discardQueued: (to) => this.signaling?.discardQueued(to),
      local: () => ({
        audio: media?.state.audio ?? null,
        video: media?.state.video ?? null,
        stream: media?.state.stream ?? null,
        mode: this.state.value.local.mode,
        sourceShortSide: media?.sourceShortSide,
      }),
      announce: () => this.announce(),
      codecPrefs: {
        red: d.flags.red,
        videoOrder,
        videoStartKbps: d.flags.vstart,
        videoMinKbps: d.flags.vmin,
        videoMaxKbps: d.flags.vmax,
        videoJitterTargetMs: d.flags.jbt,
        videoScalability: d.flags.svc,
        audio: d.flags.audio,
        videoExclude: this.videoExclusions(videoOrder),
      },
      ...(d.flags.cpuguard === false ? { cpuGuard: false } : {}),
      onCpuLevel: (level) => this.onCpuLevel(level),
      getCapabilities: d.getCapabilities,
      ...(d.flags.vlevel ? { levelOverride: d.flags.vlevel } : {}),
      ...(d.flags.relayOnly ? { relayOnly: true } : {}),
      log: this.log.scope("peer"),
    });
    this.transport = transport;
    this.unsubTransport = transport.onChange(() => {
      this.syncParticipants();
      if (this.awaitingRoster) this.enterCallWhenResolved();
    });
    transport.setLocalState(this.announce());
    transport.setHidden(d.document?.visibilityState === "hidden");

    let welcomes = 0;
    const signaling = new SignalingClient({
      url: roomUrl(d.location, this.keys.roomId),
      peerId,
      cipher: d.crypto.cipher(this.keys),
      WebSocket: d.WebSocket!,
      clock: d.clock,
      random: d.random,
      log: this.log.scope("signaling"),
      // P2P media survives a signaling outage: keep the call (phase "reconnecting") while any pair is connected.
      isCallAlive: () => transport.participants().some((p) => p.status === "connected"),
      handlers: {
        status: (st) => {
          if (this.signaling !== signaling) return;
          transport.signalingUp(st === "open");
          if (st === "reconnecting" && this.state.value.phase === "in-call") this.setPhase("reconnecting");
        },
        welcome: (info) => {
          if (this.signaling !== signaling) return;
          transport.welcome(info, welcomes++ === 0);
          const phase = this.state.value.phase;
          // Stay "joining" until every listed peer is heard from or known to be away, so the call screen never
          // flashes a ghost tile (our own pre-reload peerId) nor an empty "Waiting for others".
          if (phase === "joining") this.enterCallWhenResolved();
          else if (phase === "reconnecting") this.setPhase("in-call");
        },
        peerJoined: (id) => transport.peerJoined(id),
        peerLeft: (id, reason) => transport.peerLeft(id, reason),
        signal: (from, payload) => transport.signal(from, payload),
        error: (code, id) => transport.signalingError(code, id),
        fatal: (code, detail) => {
          if (this.signaling === signaling) this.onFatal(code, detail);
        },
      },
    });
    this.signaling = signaling;
    signaling.connect();
  }

  private enterCallWhenResolved() {
    const t = this.transport;
    if (!t || this.state.value.phase !== "joining") {
      this.awaitingRoster = false;
      return;
    }
    this.awaitingRoster = t.resolving;
    if (!this.awaitingRoster) this.enterCall();
  }

  private enterCall() {
    this.everInCall = true;
    this.setPhase("in-call", { joinedAt: this.d.clock.now(), endedAt: null });
    this.sampler.start();
    this.d.clock.clearInterval(this.levelTimer);
    this.levelTimer = this.d.clock.setInterval(() => this.pollLevels(), LEVEL_POLL_MS);
  }

  private onFatal(code: FatalSignalingCode, detail?: string) {
    const mapped = fatalToError(code);
    const error: CallError | null = mapped ? { code: mapped, ...(detail ? { detail } : {}) } : null;
    this.L.error("fatal", { code, ...(mapped ? { mapped } : {}) });
    const wasInCall = this.everInCall;
    this.teardown({ bye: false });
    if (wasInCall || !mapped) this.setPhase("ended", { error, endedAt: this.d.clock.now() });
    else this.setPhase("error", { error });
  }

  private pollLevels() {
    const t = this.transport;
    if (!t) return;
    const snap = this.speaker.update(t.audioLevels(), this.d.clock.now());
    const s = this.state.value;
    let changed = snap.activeId !== s.activeSpeakerId;
    const participants = s.participants.map((p) => {
      const level = Math.round((snap.levels.get(p.id) ?? 0) * 100) / 100;
      const speaking = snap.speaking.has(p.id);
      if (Math.abs(level - p.audioLevel) < 0.02 && speaking === p.speaking) return p;
      changed = true;
      return { ...p, audioLevel: level, speaking };
    });
    if (changed) this.patch({ participants, activeSpeakerId: snap.activeId });
  }

  leave(): void {
    const phase = this.state.value.phase;
    if (phase === "idle" || phase === "ended") {
      this.teardown({ bye: true });
      return;
    }
    this.L.info("leave", { phase });
    this.teardown({ bye: true });
    this.setPhase("ended", { endedAt: this.d.clock.now(), error: null });
  }

  setMic(on: boolean): void {
    if (on && this.media && !this.media.state.audio) {
      // Never granted (listen-only) or lost: the tap asks for the mic only.
      void this.requestMedia({ video: false });
      return;
    }
    this.media?.setMic(on);
    this.syncLocalFromMedia();
    this.transport?.setLocalState(this.announce());
  }

  async setCam(on: boolean): Promise<void> {
    if (on && this.media && !this.media.state.video && !this.media.everHad("video")) {
      // Never granted: the tap asks for the camera (plus the mic if it was never asked for — it stays muted).
      await this.requestMedia({ video: true });
      return;
    }
    await this.media?.setCam(on);
    this.syncLocalFromMedia();
    this.transport?.setLocalState(this.announce());
  }

  async switchCamera(): Promise<void> {
    await this.media?.switchCamera();
    this.syncLocalFromMedia();
  }

  async setMode(mode: AudioMode): Promise<void> {
    if (!this.media) {
      this.patchLocal({ mode });
      return;
    }
    await this.media.setMode(mode);
    this.syncLocalFromMedia();
    this.transport?.setLocalState(this.announce());
  }

  setName(name: string): void {
    const n = name.trim().slice(0, MAX_NAME_LENGTH);
    this.patchLocal({ name: n });
    try {
      this.d.storage?.setItem(NAME_STORAGE_KEY, n);
    } catch {}
    this.transport?.setLocalState(this.announce());
  }

  reportView(participantId: string, heightPx: number): void {
    this.transport?.reportView(participantId, heightPx);
  }

  async resumeAudio(): Promise<void> {
    await this.remoteAudio.resume();
  }

  retryPeer(participantId: string): void {
    this.transport?.retry(participantId);
  }

  async shareLink(): Promise<"shared" | "copied" | "cancelled"> {
    const link = this.state.value.link;
    if (!link) return "cancelled";
    const nav = this.d.navigator;
    if (nav.share) {
      try {
        await nav.share({ url: link, title: "Clearcall" });
        return "shared";
      } catch (e) {
        if (errInfo(e).err === "AbortError") return "cancelled";
        this.L.info("share failed, falling back to clipboard", errInfo(e));
      }
    }
    try {
      if (!nav.clipboard) return "cancelled";
      await nav.clipboard.writeText(link);
      return "copied";
    } catch (e) {
      this.L.warn("clipboard failed", errInfo(e));
      return "cancelled";
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.teardown({ bye: true });
    this.disposed = true;
    this.telemetry?.stop();
    this.uninstallQa?.();
    this.d.window?.removeEventListener("pagehide", this.onPageHide);
    this.d.window?.removeEventListener("online", this.onOnline);
    this.d.document?.removeEventListener("visibilitychange", this.onVisibility);
  }

  // ── lifecycle internals ──

  /** Stop everything call-related (media, transport, signaling, timers). Phase is left to the caller. */
  private teardown(opts: { bye: boolean }) {
    this.generation++;
    this.awaitingRoster = false;
    batch(() => {
      this.d.clock.clearInterval(this.levelTimer);
      this.levelTimer = undefined;
      this.sampler.stop();
      this.unsubTransport?.();
      this.unsubTransport = null;
      this.transport?.close({ bye: opts.bye });
      this.transport = null;
      const sig = this.signaling;
      this.signaling = null;
      if (opts.bye) sig?.leave();
      else sig?.close();
      this.media?.stop();
      this.media = null;
      this.mediaReady = null;
      this.perms?.close();
      this.perms = null;
      this.denied.clear();
      this.autoAgain = false;
      this.remoteAudio.close();
      this.speaker.reset();
      this.releaseWakeLock();
      if (this.state.value.participants.length || this.state.value.local.stream) {
        this.patch({ participants: [], activeSpeakerId: null });
        this.patchLocal({ stream: null, audioLevel: 0, speaking: false });
      }
    });
    if (this.peerId) this.L.info("torn down", { peer: short(this.peerId), bye: opts.bye });
  }

  private requestWakeLock() {
    this.wantWakeLock = true;
    const wl = this.d.navigator.wakeLock;
    if (!wl || this.wakeLock) return;
    wl.request("screen").then(
      (lock) => {
        if (!this.wantWakeLock) void lock.release().catch(() => {});
        else this.wakeLock = lock;
      },
      (e) => this.L.debug("wake lock refused", errInfo(e)),
    );
  }

  private releaseWakeLock() {
    this.wantWakeLock = false;
    const l = this.wakeLock;
    this.wakeLock = null;
    void l?.release().catch(() => {});
  }

  private inCallish(): boolean {
    const p = this.state.value.phase;
    return p === "joining" || p === "in-call" || p === "reconnecting";
  }

  private onVisibility = () => {
    const hidden = this.d.document?.visibilityState === "hidden";
    this.transport?.setHidden(hidden);
    if (!hidden && this.inCallish()) {
      // The OS drops wake locks when hidden; re-request.
      this.wakeLock = null;
      this.requestWakeLock();
    }
    // Back from Settings after blocking camera/mic: re-acquire if the browser now reports it granted.
    if (!hidden && this.denied.size) void this.autoReacquire("visible");
  };

  private onPageHide = () => {
    if (this.inCallish()) {
      // Signaling `leave` first, synchronously: it is what makes the server broadcast peer-left{left} at once
      // (else our peerId lingers "away" for the grace window and a reloaded tab sees it in welcome.peers).
      // The ctl `bye`s over the data channels are a best-effort second path.
      this.L.info("pagehide: leaving");
      this.signaling?.leave();
      this.transport?.close({ bye: true });
    }
    void this.telemetry?.flush(true);
  };

  private onOnline = () => {
    this.signaling?.nudge();
  };
}

/** Real call engine factory (installs telemetry and, with ?qa=1, `window.__clearcall`). */
export function createCallController(deps: Partial<CoreDeps> = {}): CallController & CallControllerInternals {
  const base = defaultDeps();
  const merged: CoreDeps = {
    ...base,
    ...deps,
    navigator: deps.navigator ?? base.navigator,
    flags: { ...base.flags, ...deps.flags },
  };
  return new Controller(merged);
}
