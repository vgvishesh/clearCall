/**
 * The contract between the call engine (src/core) and the UI (src/ui).
 * UI code may import ONLY from this file, testids.ts and the controller factory — never WebRTC APIs.
 * Changing this file = changing the contract: update the real controller, FakeCallController and all UI usages together.
 */
import type { ReadonlySignal } from "@preact/signals";

export type AudioMode = "voice" | "music";
export type Facing = "user" | "environment";

/**
 * Phase semantics:
 * - Lobby problems (camera/mic denied or missing) stay in phase "lobby" with `error` set
 *   (code permission-denied | no-devices; see `local.camAvailable/micAvailable` for which device).
 * - Fatal problems before joining → phase "error" (room-full, unsupported, invalid-link, version-mismatch,
 *   signaling-unavailable while joining).
 * - Fatal problems after having been in the call (signaling gone for > 60 s, version-mismatch) → phase "ended" with `error` set.
 * - The controller is reusable: from "ended" or "error", `prepare({link})` starts over (Rejoin), `prepare({})` makes a new call.
 */
export type CallPhase =
  /** Nothing acquired yet (Home screen). */
  | "idle"
  /** Media preview + name entry before joining (Lobby). */
  | "lobby"
  /** Connecting to signaling / waiting for welcome. */
  | "joining"
  | "in-call"
  /** Signaling socket dropped; media may still flow. UI shows a subtle banner, not a blocking screen. */
  | "reconnecting"
  /** User left, or was removed by a fatal error after being in the call. */
  | "ended"
  /** Fatal error before/while joining (see `error`). */
  | "error";

export type CallErrorCode =
  /** User or OS blocked camera/mic. */
  | "permission-denied"
  /** No camera/mic hardware, or in use by another app. */
  | "no-devices"
  | "room-full"
  /** Browser lacks WebRTC / getUserMedia / WebCrypto / secure context. */
  | "unsupported"
  /** Link malformed (bad or missing secret). */
  | "invalid-link"
  /** Can't reach the signaling server after retries. */
  | "signaling-unavailable"
  /** Server speaks a different protocol version (app updated) — user should reload. */
  | "version-mismatch";

export interface CallError {
  code: CallErrorCode;
  /** Developer-facing detail; the UI maps `code` to user copy. */
  detail?: string;
}

export type PeerConnectionStatus = "connecting" | "connected" | "reconnecting" | "failed";
export type ConnectionQuality = "good" | "fair" | "poor" | "unknown";

export interface LocalParticipant {
  name: string;
  micOn: boolean;
  camOn: boolean;
  mode: AudioMode;
  facing: Facing;
  /** Preview stream (video track may be absent when camera is off). Null until media is acquired. */
  stream: MediaStream | null;
  /** 0..1, smoothed, updated ~10×/s while mic is on. */
  audioLevel: number;
  speaking: boolean;
  /** True when the device has more than one camera (show flip button). */
  canSwitchCamera: boolean;
  /** False when the camera is missing or denied (UI offers "Join without camera"). */
  camAvailable: boolean;
  /** False when the microphone is missing or denied (joining is still allowed, muted). */
  micAvailable: boolean;
}

export interface RemoteParticipant {
  /** Protocol peerId. Stable for the session; use as React key. */
  id: string;
  /** From hello/state; "" until known (UI shows "Guest"). */
  name: string;
  micOn: boolean;
  camOn: boolean;
  mode: AudioMode;
  /**
   * Remote media. Null until the first track arrives. The UI attaches it to `<video autoplay playsinline muted>` —
   * ALWAYS muted: the controller plays remote audio through its own hidden <audio> elements (one per participant,
   * unaffected by layout changes) and reports autoplay rejection via `CallState.audioBlocked`.
   */
  stream: MediaStream | null;
  status: PeerConnectionStatus;
  quality: ConnectionQuality;
  audioLevel: number;
  speaking: boolean;
}

/**
 * Our device can't keep up with video (CPU overload guard, ADR-0010): "reduced" = video sent and received at ≤ 360p
 * 15 fps; "paused" = video off both ways so audio stays clear. null = normal. Recovers by itself.
 */
export type VideoLimit = "reduced" | "paused" | null;

export interface CallState {
  phase: CallPhase;
  error: CallError | null;
  /** Shareable link (`https://host/c#secret`), known from `prepare()` on. */
  link: string | null;
  local: LocalParticipant;
  /** In join order. Max 9 (10 including local). */
  participants: RemoteParticipant[];
  /** Remote participant id currently speaking loudest (hysteresis applied), or null. */
  activeSpeakerId: string | null;
  /** True once remote audio needs a user gesture to start (iOS autoplay). UI shows "Tap to enable audio". */
  audioBlocked: boolean;
  /** Epoch ms when the local user entered `in-call`, for the call timer. */
  joinedAt: number | null;
  /** Epoch ms when the call ended (Ended screen shows endedAt - joinedAt). */
  endedAt: number | null;
  /** Local device overload: video stepped down or paused to protect audio (UI shows a calm notice for "paused"). */
  videoLimited: VideoLimit;
}

export interface CallController {
  readonly state: ReadonlySignal<CallState>;

  /**
   * Go to the lobby: parse/create the link and acquire camera+mic for preview.
   * `link` = the current URL or a pasted link (join), or undefined (start a new call: generates a secret).
   * Always `history.replaceState` to `/c#<secret>` so reload/share use the canonical URL.
   * Must be called from a user gesture on iOS for reliable permission prompts.
   * The factory `createCallController()` also installs telemetry and (with ?qa=1) `window.__clearcall`.
   */
  prepare(opts: { link?: string; name?: string }): Promise<void>;

  /** Join the room from the lobby. Must be called from a user gesture (unlocks audio playback on iOS). */
  join(name: string): Promise<void>;

  /** Leave the call, stop all media, phase → "ended". Safe to call in any phase. */
  leave(): void;

  setMic(on: boolean): void;
  setCam(on: boolean): Promise<void>;
  switchCamera(): Promise<void>;
  setMode(mode: AudioMode): Promise<void>;
  /** Truncated to MAX_NAME_LENGTH (40) from @clearcall/protocol; persisted to localStorage. */
  setName(name: string): void;

  /** UI reports the rendered size of a participant's video tile (CSS px × devicePixelRatio); 0 = hidden. */
  reportView(participantId: string, heightPx: number): void;

  /** Call from a user gesture after `audioBlocked` became true. */
  resumeAudio(): Promise<void>;

  /** Retry a failed peer connection (ICE restart / renegotiate). */
  retryPeer(participantId: string): void;

  /** Share the link via Web Share API, falling back to clipboard. */
  shareLink(): Promise<"shared" | "copied" | "cancelled">;

  /** Release everything (component unmount). */
  dispose(): void;
}

/** Shape exposed as `window.__clearcall` when the page is opened with `?qa=1` (E2E, quality lab, diagnostics contract). */
export interface QaHook {
  state(): CallState;
  /** One entry per remote participant. Missing browser stats fields are undefined, never throw. */
  stats(): Promise<QaPeerStats[]>;
  /** Stats sampled every second since join (ring buffer, last 600 samples). */
  statsTimeline(): QaStatsSample[];
  /** Structured log ring buffer (last 2000 entries) from every core module. */
  logs(): LogEntry[];
  /** Which media transport is active (mesh now; sfu when implemented). */
  transport(): TransportKind;
  /** Start recording remote media for the quality lab; resolves with a webm Blob per participant on stop. */
  startRecording(participantId: string): void;
  stopRecording(participantId: string): Promise<Blob | null>;
  /** Fault injection for resilience tests. */
  /**
   * `cpu-overload`: from now on the CPU guard (ADR-0010) sees this device as starved (encode 150 ms/frame at 5 fps),
   * so E2E can drive its steps in real browsers.
   */
  inject(
    fault: "drop-signaling" | "restart-ice" | "kill-peer" | "cpu-overload",
    participantId?: string,
  ): void;
}

export type TransportKind = "mesh" | "sfu";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  /** Epoch ms. */
  t: number;
  level: LogLevel;
  /** Module: "signaling" | "peer" | "media" | "controller" | "policy" | "ui" | ... */
  scope: string;
  msg: string;
  /** Small JSON-safe context (peer id, state names, error names). Never SDP bodies, keys or names of people. */
  data?: Record<string, unknown>;
}

export interface QaStatsSample {
  t: number;
  /** Local process view. */
  local: {
    /** Sum over outbound video: totalEncodeTime / framesEncoded (ms per frame) — CPU cost signal. */
    encodeMsPerFrame?: number;
    outboundKbps?: number;
    inboundKbps?: number;
    /** Main-thread long tasks (ms) during the last second, via PerformanceObserver('longtask') where supported. */
    longTaskMs?: number;
    /** JS heap used (MB) where `performance.memory` exists. */
    heapMb?: number;
  };
  peers: QaPeerStats[];
}

export interface QaPeerStats {
  id: string;
  name: string;
  connectionState: RTCPeerConnectionState;
  candidateType?: string;
  rttMs?: number;
  availableOutgoingBitrate?: number;
  audio: {
    bytesReceived?: number;
    bytesSent?: number;
    packetsLost?: number;
    jitter?: number;
    audioLevel?: number;
    concealedSamples?: number;
    totalSamplesReceived?: number;
    codec?: string;
    /** outbound-rtp targetBitrate of our audio to this peer (bps). */
    targetBitrate?: number;
    /** outbound-rtp retransmittedBytesSent (audio has no RTX in practice; RED/FEC are inside bytesSent). */
    retransmittedBytesSent?: number;
    /** inbound-rtp fecPacketsReceived (Opus in-band FEC / RED recoveries counted by the receiver). */
    fecPacketsReceived?: number;
  };
  video: {
    bytesReceived?: number;
    bytesSent?: number;
    framesDecoded?: number;
    framesDropped?: number;
    freezeCount?: number;
    totalFreezesDuration?: number;
    frameHeight?: number;
    framesPerSecond?: number;
    sentFrameHeight?: number;
    qualityLimitationReason?: string;
    /** totalDecodeTime / framesDecoded (ms). */
    decodeMsPerFrame?: number;
    /** totalEncodeTime / framesEncoded (ms) for our outbound stream to this peer. */
    encodeMsPerFrame?: number;
    /** jitterBufferDelay / jitterBufferEmittedCount (ms). */
    jitterBufferMs?: number;
    codec?: string;
    /** Receiver-reported loss of our video (remote-inbound-rtp fractionLost, 0..1). */
    remoteFractionLost?: number;
    /** Our adaptive send level to this peer (3–4 tier, ADR-0008): "base" 600 kbps or "high" 800 kbps. */
    sendLevel?: "base" | "high";
    /** The video maxBitrate we applied to this peer's encoding (bps). */
    sendMaxBitrate?: number;
    /** Floor-guard cap on our video to this peer (bps, ADR-0009); absent = none. */
    guardCap?: number;
    /** Camera frames per second (media-source stats) — the CPU guard's expected send rate. */
    sourceFps?: number;
    /** CPU overload guard level of this device (ADR-0010): normal | reduced | paused. */
    cpuLevel?: "normal" | "reduced" | "paused";
    // Loss-recovery attribution (cumulative counters; lab/diag diff them). Sender side = our stream to this peer.
    /** outbound-rtp retransmittedBytesSent (RTX payload, a subset of bytesSent). */
    retransmittedBytesSent?: number;
    /** outbound-rtp headerBytesSent (RTP headers incl. extensions, not in bytesSent). */
    headerBytesSent?: number;
    /** outbound-rtp packetsSent. */
    packetsSent?: number;
    /** outbound-rtp targetBitrate (encoder target, bps). */
    targetBitrate?: number;
    /** outbound-rtp framesPerSecond (what we encode for this peer). */
    sentFramesPerSecond?: number;
    /** outbound-rtp keyFramesEncoded. */
    keyFramesEncoded?: number;
    /** outbound-rtp nackCount / pliCount: NACKs and PLIs this peer sent us. */
    nackReceived?: number;
    pliReceived?: number;
    // Receiver side = this peer's stream to us.
    /** inbound-rtp packetsLost / packetsReceived (video). */
    packetsLost?: number;
    packetsReceived?: number;
    /** inbound-rtp fecPacketsReceived / retransmittedBytesReceived: how much of the peer's stream was FEC / RTX. */
    fecPacketsReceived?: number;
    retransmittedBytesReceived?: number;
    /** inbound-rtp keyFramesDecoded, pliCount, nackCount (PLIs / NACKs we sent). */
    keyFramesDecoded?: number;
    pliSent?: number;
    nackSent?: number;
  };
  /** Derived kbps since the previous sample (both directions, audio+video). */
  inboundKbps?: number;
  outboundKbps?: number;
}
