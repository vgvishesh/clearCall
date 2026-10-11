/**
 * Clearcall wire protocol v1 — the single source of truth for every message shape.
 *
 * Three layers:
 *  1. Client ⇄ Server (WebSocket JSON). The server only ever sees peer ids and opaque `data` blobs.
 *  2. Peer ⇄ Peer via the server (`SignalPayload`), AES-GCM encrypted inside `signal.data` (see crypto.ts).
 *  3. Peer ⇄ Peer over the negotiated RTCDataChannel "ctl" (`PeerMessage`), after connection.
 *
 * Compatibility rules: receivers ignore unknown fields and unknown message types (`parse*` returns null);
 * additive changes keep PROTOCOL_VERSION; breaking changes bump it.
 */

export const PROTOCOL_VERSION = 1;
export const MAX_PARTICIPANTS = 10;
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** Seconds the server keeps a disconnected peer before broadcasting `peer-left` (resume window). */
export const RESUME_GRACE_SECONDS = 20;
/** Hibernation auto-response heartbeat: client sends exactly this string, server answers `HEARTBEAT_RESPONSE`. */
export const HEARTBEAT_REQUEST = "ping";
export const HEARTBEAT_RESPONSE = "pong";
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** 22 base64url chars = 132 bits, derived from the link secret (crypto.ts). */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** 16 base64url chars = 96 bits, random per browser tab session. */
export const PEER_ID_RE = /^[A-Za-z0-9_-]{16}$/;
/** base64url of (12-byte IV ‖ AES-GCM ciphertext). Bounded by MAX_MESSAGE_BYTES overall. */
export const BLOB_RE = /^[A-Za-z0-9_-]+$/;

export const MAX_NAME_LENGTH = 40;

// ───────────────────────────── 1. Client ⇄ Server ─────────────────────────────

export type ClientMessage =
  /** First message on every socket. `resume: true` re-binds an existing peerId within the grace window. */
  | { t: "join"; v: number; peerId: string; resume?: boolean }
  /** Relay an encrypted SignalPayload to one peer in the room. */
  | { t: "signal"; to: string; data: string }
  /** Graceful leave: server broadcasts `peer-left` immediately and closes the socket. */
  | { t: "leave" };

export type ErrorCode =
  | "room-full"
  | "bad-message"
  | "version"
  | "rate-limited"
  | "not-joined"
  | "unknown-peer"
  | "too-large"
  | "duplicate-peer";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type ServerMessage =
  /** Reply to `join`. `peers` = everyone else currently in the room (including peers in their resume window). */
  | { t: "welcome"; v: number; peerId: string; peers: string[]; iceServers: IceServer[]; resumed: boolean }
  | { t: "peer-joined"; peerId: string }
  | { t: "peer-left"; peerId: string; reason: "left" | "timeout" }
  | { t: "signal"; from: string; data: string }
  /** Fatal codes (room-full, version, duplicate-peer) are followed by the server closing the socket. */
  | { t: "error"; code: ErrorCode; message?: string };

// ─────────────────────── 2. Peer ⇄ Peer, encrypted via the server ───────────────────────

export type SdpType = "offer" | "answer" | "pranswer" | "rollback";

export interface IceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type SignalPayload =
  /** Sent by both sides when a pair first learns of each other (newcomer → existing peers, existing → newcomer). */
  | { k: "hello"; name: string }
  | { k: "sdp"; description: { type: SdpType; sdp: string } }
  /** `candidate: null` = end of candidates. */
  | { k: "ice"; candidate: IceCandidateInit | null };

// ─────────────────────── 3. Peer ⇄ Peer over the "ctl" data channel ───────────────────────

export const CONTROL_CHANNEL_LABEL = "ctl";
export const CONTROL_CHANNEL_ID = 0;

export type AudioMode = "voice" | "music";

export type PeerMessage =
  /** Full current state; sent on channel open and whenever any field changes. */
  | { k: "state"; name: string; mic: boolean; cam: boolean; mode: AudioMode }
  /**
   * Receiver → sender: how big the sender's video is rendered here, in device pixels (0 = not visible).
   * The sender caps its encode for this connection accordingly (web/src/core/policy.ts).
   */
  | { k: "view"; height: number }
  /** Sender is leaving deliberately (faster than waiting for signaling's peer-left). */
  | { k: "bye" };

// ───────────────────────────────── Validators ─────────────────────────────────
// Hand-written, dependency-free. Return the typed message or null; never throw.

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isBool = (x: unknown): x is boolean => typeof x === "boolean";
const isPeerId = (x: unknown): x is string => isStr(x) && PEER_ID_RE.test(x);
const isBlob = (x: unknown): x is string =>
  isStr(x) && x.length > 0 && x.length <= MAX_MESSAGE_BYTES && BLOB_RE.test(x);
const isName = (x: unknown): x is string => isStr(x) && x.length <= MAX_NAME_LENGTH;

function parseJson(raw: unknown): unknown {
  if (isObj(raw)) return raw;
  if (!isStr(raw) || raw.length > MAX_MESSAGE_BYTES) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  const m = parseJson(raw);
  if (!isObj(m)) return null;
  switch (m.t) {
    case "join":
      if (typeof m.v !== "number" || !isPeerId(m.peerId)) return null;
      if (m.resume !== undefined && !isBool(m.resume)) return null;
      return { t: "join", v: m.v, peerId: m.peerId, ...(m.resume ? { resume: true } : {}) };
    case "signal":
      if (!isPeerId(m.to) || !isBlob(m.data)) return null;
      return { t: "signal", to: m.to, data: m.data };
    case "leave":
      return { t: "leave" };
    default:
      return null;
  }
}

const ERROR_CODES: readonly ErrorCode[] = [
  "room-full",
  "bad-message",
  "version",
  "rate-limited",
  "not-joined",
  "unknown-peer",
  "too-large",
  "duplicate-peer",
];

function isIceServer(x: unknown): x is IceServer {
  if (!isObj(x)) return false;
  const urlsOk = isStr(x.urls) || (Array.isArray(x.urls) && x.urls.every(isStr));
  return (
    urlsOk &&
    (x.username === undefined || isStr(x.username)) &&
    (x.credential === undefined || isStr(x.credential))
  );
}

export function parseServerMessage(raw: unknown): ServerMessage | null {
  const m = parseJson(raw);
  if (!isObj(m)) return null;
  switch (m.t) {
    case "welcome":
      if (typeof m.v !== "number" || !isPeerId(m.peerId)) return null;
      if (!Array.isArray(m.peers) || !m.peers.every(isPeerId)) return null;
      if (!Array.isArray(m.iceServers) || !m.iceServers.every(isIceServer)) return null;
      return {
        t: "welcome",
        v: m.v,
        peerId: m.peerId,
        peers: m.peers,
        iceServers: m.iceServers,
        resumed: m.resumed === true,
      };
    case "peer-joined":
      return isPeerId(m.peerId) ? { t: "peer-joined", peerId: m.peerId } : null;
    case "peer-left":
      if (!isPeerId(m.peerId) || (m.reason !== "left" && m.reason !== "timeout")) return null;
      return { t: "peer-left", peerId: m.peerId, reason: m.reason };
    case "signal":
      return isPeerId(m.from) && isBlob(m.data) ? { t: "signal", from: m.from, data: m.data } : null;
    case "error":
      if (!ERROR_CODES.includes(m.code as ErrorCode)) return null;
      return { t: "error", code: m.code as ErrorCode, ...(isStr(m.message) ? { message: m.message } : {}) };
    default:
      return null;
  }
}

const SDP_TYPES: readonly SdpType[] = ["offer", "answer", "pranswer", "rollback"];

function isCandidate(x: unknown): x is IceCandidateInit {
  if (!isObj(x) || !isStr(x.candidate)) return false;
  const optStrOrNull = (v: unknown) => v === undefined || v === null || isStr(v);
  const optNumOrNull = (v: unknown) => v === undefined || v === null || typeof v === "number";
  return optStrOrNull(x.sdpMid) && optNumOrNull(x.sdpMLineIndex) && optStrOrNull(x.usernameFragment);
}

export function parseSignalPayload(raw: unknown): SignalPayload | null {
  const m = parseJson(raw);
  if (!isObj(m)) return null;
  switch (m.k) {
    case "hello":
      return isName(m.name) ? { k: "hello", name: m.name } : null;
    case "sdp": {
      const d = m.description;
      if (!isObj(d) || !SDP_TYPES.includes(d.type as SdpType) || !isStr(d.sdp)) return null;
      return { k: "sdp", description: { type: d.type as SdpType, sdp: d.sdp } };
    }
    case "ice":
      if (m.candidate === null) return { k: "ice", candidate: null };
      return isCandidate(m.candidate) ? { k: "ice", candidate: m.candidate } : null;
    default:
      return null;
  }
}

export function parsePeerMessage(raw: unknown): PeerMessage | null {
  const m = parseJson(raw);
  if (!isObj(m)) return null;
  switch (m.k) {
    case "state":
      if (!isName(m.name) || !isBool(m.mic) || !isBool(m.cam)) return null;
      if (m.mode !== "voice" && m.mode !== "music") return null;
      return { k: "state", name: m.name, mic: m.mic, cam: m.cam, mode: m.mode };
    case "view":
      if (typeof m.height !== "number" || !Number.isFinite(m.height) || m.height < 0 || m.height > 4320)
        return null;
      return { k: "view", height: Math.round(m.height) };
    case "bye":
      return { k: "bye" };
    default:
      return null;
  }
}
