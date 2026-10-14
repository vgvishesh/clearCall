/**
 * Media transport seam (ADR-0006). The controller talks only to `MediaTransport`; `MeshTransport` (one
 * RTCPeerConnection per remote peer) is V1, an `SfuTransport` (Cloudflare Realtime) can implement the same
 * interface later. Room presence still comes from the signaling client, so presence events are inputs here.
 */
import type { ErrorCode, PeerMessage, SignalPayload } from "@clearcall/protocol";
import type { WelcomeInfo } from "../signaling-client.ts";
import type {
  AudioMode,
  ConnectionQuality,
  PeerConnectionStatus,
  QaPeerStats,
  TransportKind,
} from "../types.ts";

/** What the transport knows about a remote participant (the controller adds levels/speaking). */
export interface RemoteInfo {
  id: string;
  name: string;
  micOn: boolean;
  camOn: boolean;
  mode: AudioMode;
  stream: MediaStream | null;
  status: PeerConnectionStatus;
  quality: ConnectionQuality;
}

/** Our state as announced to peers over `ctl` (`state` message). */
export interface LocalAnnounce {
  name: string;
  mic: boolean;
  cam: boolean;
  mode: AudioMode;
}

export interface MediaTransport {
  readonly kind: TransportKind;

  // ── presence & signaling input (from SignalingClient) ──
  /** `first` = the first welcome of this session (vs a reconnect). */
  welcome(info: WelcomeInfo, first: boolean): void;
  peerJoined(peerId: string): void;
  peerLeft(peerId: string, reason: "left" | "timeout"): void;
  signal(from: string, payload: SignalPayload): void;
  signalingError(code: ErrorCode, peerId?: string): void;
  signalingUp(up: boolean): void;

  // ── local media ──
  setLocalTrack(kind: "audio" | "video", track: MediaStreamTrack | null): void;
  setLocalState(state: LocalAnnounce): void;

  // ── policy inputs ──
  reportView(participantId: string, heightPx: number): void;
  setHidden(hidden: boolean): void;

  // ── remote side ──
  /** Visible remote participants. Peers hidden until heard from (FLOWS §4) are left out. */
  participants(): RemoteInfo[];
  /**
   * True while peers listed in a welcome are still being probed (neither heard from nor reported unknown by the
   * server, bounded by a short timeout). The controller stays in "joining" meanwhile so no ghost tile flashes.
   */
  readonly resolving: boolean;
  /** Raw remote audio levels 0..1, cheap enough to poll at ~5 Hz. */
  audioLevels(): Map<string, number>;
  /** Per-participant stats (also refreshes quality badges). */
  /**
   * Per-peer stats. `consumer` keys the baseline used for interval rates (kbps, loss, ms/frame), so independent
   * pollers (the 1 Hz sampler vs. QA/E2E probes) never corrupt each other's deltas.
   */
  stats(consumer?: string): Promise<QaPeerStats[]>;
  /** Subscribe to participant list/info changes. Returns unsubscribe. */
  onChange(cb: () => void): () => void;

  // ── control ──
  retry(participantId: string): void;
  restartIce(participantId?: string): void;
  kill(participantId?: string): void;
  /** QA fault: the CPU guard sees this device as starved from now on (ADR-0010). */
  simulateCpuOverload(): void;
  /** Send a `ctl` message to everyone with an open channel. */
  broadcast(msg: PeerMessage): void;
  close(opts?: { bye?: boolean }): void;
}
