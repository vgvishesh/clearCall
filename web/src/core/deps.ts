/**
 * Everything the engine takes from the browser, injectable for tests (`createCallController(deps)`).
 * `defaultDeps()` reads real globals defensively (missing APIs → undefined → "unsupported" where required).
 */
import { deriveRoomKeys, generatePeerId, generateSecret, type RoomKeys } from "@clearcall/protocol";
import type { AudioElementLike } from "./audio-out.ts";
import { type Clock, realClock } from "./clock.ts";
import type { CodecLike, MediaCapabilitiesLike } from "./codecs.ts";
import type { AudioContextLike, MediaDevicesLike } from "./media.ts";
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
  /** Mirror debug logs to the console (`?debug=1`). */
  debug: boolean;
  /** Install window.__clearcall (`?qa=1`). */
  qa: boolean;
  /** Probe /api/dev/config and ship telemetry when the Worker allows it. */
  telemetry: boolean;
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
  return { red: on("red"), debug: on("debug"), qa: on("qa"), telemetry: true };
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
    flags: flagsFrom(loc.search),
  };
}
