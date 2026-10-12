/**
 * Everything the engine takes from the browser, injectable for tests (`createCallController(deps)`).
 * `defaultDeps()` reads real globals defensively (missing APIs → undefined → "unsupported" where required).
 */
import { deriveRoomKeys, generatePeerId, generateSecret, type RoomKeys } from "@clearcall/protocol";
import type { AudioElementLike } from "./audio-out.ts";
import { type Clock, realClock } from "./clock.ts";
import type { CodecLike, MediaCapabilitiesLike } from "./codecs.ts";
import type { AudioContextLike, AudioTuning, MediaDevicesLike } from "./media.ts";
import { roomCipher, type SignalCipher, type WebSocketCtor } from "./signaling-client.ts";

export interface CryptoDeps {
  /** WebCrypto (crypto.subtle) present. */
  available: boolean;
  generateSecret(): string;
  generatePeerId(): string;
  deriveRoomKeys(secret: string): Promise<RoomKeys>;
  cipher(keys: RoomKeys): SignalCipher;
}

export interface WakeLockLike {
  release(): Promise<void>;
}

export interface NavigatorDeps {
  share?: (data: { url?: string; title?: string; text?: string }) => Promise<void>;
  clipboard?: { writeText(s: string): Promise<void> };
  wakeLock?: { request(type: "screen"): Promise<WakeLockLike> };
  audioSession?: { type: string };
  sendBeacon?: (url: string, body: string) => boolean;
}

export interface EventTargetLike {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface DocumentDeps extends EventTargetLike {
  visibilityState: string;
}

export interface CoreFlags {
  /** Prefer RED for audio (`?red=1`); off by default. */
  red: boolean;
  /**
   * Force the video codec (`?vcodec=vp8|vp9|h264|av1`) — quality-lab bake-offs only. Absent/unknown → the
   * data-driven order (mediaCapabilities, codecs.ts).
   */
  vcodec?: string | undefined;
  /** Video start bitrate override in kbps (`?vstart=`; 0 = libwebrtc default) — quality lab only. */
  vstart?: number | undefined;
  /** Pin the 3–4 tier send level (`?vlevel=base|high`, ADR-0008) instead of adapting — quality lab A/B only. */
  vlevel?: "base" | "high" | undefined;
  /** Relay-only ICE (`?relay=1`): media must go through TURN — verifies a TURN setup; fails without TURN. */
  relayOnly?: boolean;
  /** Mirror debug logs to the console (`?debug=1`). */
  debug: boolean;
  /** Install window.__clearcall (`?qa=1`). */
  qa: boolean;
  /** Probe /api/dev/config and ship telemetry when the Worker allows it. */
  telemetry: boolean;
  /** Audio variant overrides for the quality lab (`?abr=&mabr=&ns=&agc=&dtx=&fec=`); undefined = defaults. */
  audio?: AudioTuning | undefined;
}

export interface CoreDeps {
  clock: Clock;
  random: () => number;
  crypto: CryptoDeps;
  WebSocket: WebSocketCtor | undefined;
  RTCPeerConnection: typeof RTCPeerConnection | undefined;
  MediaStream: typeof MediaStream | undefined;
  mediaDevices: MediaDevicesLike | undefined;
  getCapabilities: (kind: "audio" | "video") => { codecs: CodecLike[] } | null;
  mediaCapabilities: MediaCapabilitiesLike | undefined;
  /** `navigator.userAgent` — only for engine-specific media workarounds (codecs.untrustedPowerEfficient). */
  userAgent: string;
  location: { origin: string; protocol: string; host: string; search: string; href: string };
  history: { replaceState(data: unknown, unused: string, url: string): void } | undefined;
  document: DocumentDeps | undefined;
  window: EventTargetLike | undefined;
  navigator: NavigatorDeps;
  fetch: typeof fetch | undefined;
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } | undefined;
  createAudioContext: (() => AudioContextLike | null) | undefined;
  createAudioElement: () => AudioElementLike | null;
  MediaRecorder: typeof MediaRecorder | undefined;
  PerformanceObserver: typeof PerformanceObserver | undefined;
  performance: { memory?: { usedJSHeapSize?: number } } | undefined;
  isSecureContext: boolean;
  /** Where `__clearcall` is installed. */
  qaTarget: object | undefined;
  flags: CoreFlags;
}

const g = globalThis as unknown as Record<string, unknown> & typeof globalThis;

function flagsFrom(search: string): CoreFlags {
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(search);
  } catch {
    p = new URLSearchParams();
  }
  const on = (k: string) => p.get(k) === "1";
  const audio = audioTuningFrom(p);
  return {
    red: on("red"),
    debug: on("debug"),
    qa: on("qa"),
    telemetry: true,
    ...(on("relay") ? { relayOnly: true } : {}),
    ...(audio ? { audio } : {}),
  };
}

/** `?abr=40000&mabr=96000&ns=0&agc=0&ec=0&dtx=0&fec=0&mstereo=1` → AudioTuning (only the keys present and valid); else undefined. */
export function audioTuningFrom(p: URLSearchParams): AudioTuning | undefined {
  const t: AudioTuning = {};
  const bps = (k: string) => {
    const v = Number(p.get(k));
    return p.has(k) && Number.isInteger(v) && v >= 6_000 && v <= 510_000 ? v : undefined;
  };
  const bool = (k: string) => (p.get(k) === "1" ? true : p.get(k) === "0" ? false : undefined);
  const voiceBitrate = bps("abr");
  const musicBitrate = bps("mabr");
  if (voiceBitrate !== undefined) t.voiceBitrate = voiceBitrate;
  if (musicBitrate !== undefined) t.musicBitrate = musicBitrate;
  for (const k of ["ns", "agc", "ec", "dtx", "fec"] as const) {
    const b = bool(k);
    if (b !== undefined) t[k] = b;
  }
  const ms = bool("mstereo");
  if (ms !== undefined) t.musicStereo = ms;
  return Object.keys(t).length ? t : undefined;
}

/**
 * Video lab overrides: `?vcodec=vp8|vp9|h264|av1` (validated by codecs.forcedVideoOrder), `?vstart=<kbps>`
 * (0…10000) and `?vlevel=base|high`. Absent/invalid → not set, so defaults stay data-driven.
 */
export function videoLabFlags(search: string): Pick<CoreFlags, "vcodec" | "vstart" | "vlevel"> {
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(search);
  } catch {
    return {};
  }
  const out: Pick<CoreFlags, "vcodec" | "vstart" | "vlevel"> = {};
  const vcodec = p.get("vcodec")?.toLowerCase();
  if (vcodec) out.vcodec = vcodec;
  const vstart = Number(p.get("vstart"));
  if (p.has("vstart") && Number.isInteger(vstart) && vstart >= 0 && vstart <= 10_000) out.vstart = vstart;
  const vlevel = p.get("vlevel");
  if (vlevel === "base" || vlevel === "high") out.vlevel = vlevel;
  return out;
}

export function defaultDeps(): CoreDeps {
  const loc = (g.location as Location | undefined) ?? {
    origin: "http://localhost",
    protocol: "http:",
    host: "localhost",
    search: "",
    href: "http://localhost/",
  };
  const nav = (g.navigator ?? {}) as Navigator & {
    audioSession?: { type: string };
  };
  const doc = g.document as Document | undefined;
  const storage = (() => {
    try {
      return g.localStorage ?? undefined;
    } catch {
      return undefined;
    }
  })();
  const AC = (g.AudioContext ?? (g as Record<string, unknown>).webkitAudioContext) as
    | (new () => AudioContextLike)
    | undefined;
  const Receiver = g.RTCRtpReceiver as typeof RTCRtpReceiver | undefined;
  return {
    clock: realClock,
    random: Math.random,
    crypto: {
      available: !!g.crypto?.subtle,
      generateSecret,
      generatePeerId,
      deriveRoomKeys,
      cipher: roomCipher,
    },
    WebSocket: g.WebSocket as unknown as WebSocketCtor | undefined,
    RTCPeerConnection: g.RTCPeerConnection,
    MediaStream: g.MediaStream,
    mediaDevices: nav.mediaDevices,
    getCapabilities: (kind) => {
      try {
        return (Receiver?.getCapabilities?.(kind) as { codecs: CodecLike[] } | null) ?? null;
      } catch {
        return null;
      }
    },
    mediaCapabilities: nav.mediaCapabilities as unknown as MediaCapabilitiesLike | undefined,
    userAgent: typeof nav.userAgent === "string" ? nav.userAgent : "",
    location: loc,
    history: g.history,
    document: doc,
    window: typeof g.addEventListener === "function" ? (g as unknown as EventTargetLike) : undefined,
    navigator: {
      ...(typeof nav.share === "function" ? { share: (d) => nav.share(d) } : {}),
      ...(nav.clipboard ? { clipboard: nav.clipboard } : {}),
      ...(nav.wakeLock
        ? { wakeLock: nav.wakeLock as unknown as NonNullable<NavigatorDeps["wakeLock"]> }
        : {}),
      ...(nav.audioSession ? { audioSession: nav.audioSession } : {}),
      ...(typeof nav.sendBeacon === "function" ? { sendBeacon: (u, b) => nav.sendBeacon(u, b) } : {}),
    },
    fetch: typeof g.fetch === "function" ? g.fetch.bind(g) : undefined,
    storage,
    createAudioContext: AC
      ? () => {
          try {
            return new AC();
          } catch {
            return null;
          }
        }
      : undefined,
    createAudioElement: () => {
      if (!doc?.createElement) return null;
      const el = doc.createElement("audio");
      el.hidden = true;
      doc.body?.appendChild(el);
      return el as unknown as AudioElementLike;
    },
    MediaRecorder: g.MediaRecorder,
    PerformanceObserver: g.PerformanceObserver,
    performance: g.performance as unknown as CoreDeps["performance"],
    isSecureContext: g.isSecureContext !== false,
    qaTarget: g,
    flags: { ...flagsFrom(loc.search), ...videoLabFlags(loc.search) },
  };
}
