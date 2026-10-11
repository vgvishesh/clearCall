/**
 * The contract between the call engine (src/core) and the UI (src/ui).
 * UI code may import ONLY from this file, testids.ts and the controller factory — never WebRTC APIs.
 * Changing this file = changing the contract: update the real controller, FakeCallController and all UI usages together.
 */
import type { ReadonlySignal } from "@preact/signals";

export type AudioMode = "voice" | "music";
export type Facing = "user" | "environment";

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
}

export interface RemoteParticipant {
  /** Protocol peerId. Stable for the session; use as React key. */
  id: string;
  /** From hello/state; "" until known (UI shows "Guest"). */
  name: string;
  micOn: boolean;
  camOn: boolean;
  mode: AudioMode;
  /** Remote media. Null until the first track arrives. Attach to <video> (audio plays through the same element). */
  stream: MediaStream | null;
  status: PeerConnectionStatus;
  quality: ConnectionQuality;
  audioLevel: number;
  speaking: boolean;
}

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
}

export interface CallController {
  readonly state: ReadonlySignal<CallState>;

  /**
   * Go to the lobby: parse/create the link and acquire camera+mic for preview.
   * `link` = the current URL (join) or undefined (start a new call: generates a secret).
   * Must be called from a user gesture on iOS for reliable permission prompts.
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

/** Shape exposed as `window.__clearcall` when the page is opened with `?qa=1` (E2E + quality lab contract). */
export interface QaHook {
  state(): CallState;
  /** One entry per remote participant. Missing browser stats fields are undefined, never throw. */
  stats(): Promise<QaPeerStats[]>;
  /** Start recording remote media for the quality lab; resolves with a webm Blob per participant on stop. */
  startRecording(participantId: string): void;
  stopRecording(participantId: string): Promise<Blob | null>;
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
    codec?: string;
  };
}
