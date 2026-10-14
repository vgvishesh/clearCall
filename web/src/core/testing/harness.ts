/**
 * Multi-controller test harness: N real `createCallController()` instances wired together through the in-memory
 * signaling server and fake WebRTC (shared clock). Test-only.
 */
import { deriveRoomKeys, generatePeerId, generateSecret } from "@clearcall/protocol";
import type { AudioElementLike } from "../audio-out.ts";
import { type CallControllerInternals, createCallController } from "../controller.ts";
import type { CoreDeps, EventTargetLike } from "../deps.ts";
import { roomCipher } from "../signaling-client.ts";
import type { CallController } from "../types.ts";
import { FakeClock } from "./fake-clock.ts";
import { FakeDocument, FakeMediaDevices } from "./fake-media.ts";
import { type FakeServerOptions, FakeSignalingServer } from "./fake-signaling.ts";
import { createFakeRtc, FakeMediaStream } from "./fake-webrtc.ts";

export class FakeWindow implements EventTargetLike {
  private l = new Map<string, Set<() => void>>();
  addEventListener(t: string, fn: () => void) {
    const s = this.l.get(t) ?? new Set();
    s.add(fn);
    this.l.set(t, s);
  }
  removeEventListener(t: string, fn: () => void) {
    this.l.get(t)?.delete(fn);
  }
  fire(t: string) {
    for (const fn of this.l.get(t) ?? []) fn();
  }
  count(t: string) {
    return this.l.get(t)?.size ?? 0;
  }
}

export class FakeAudioEl implements AudioElementLike {
  srcObject: MediaStream | null = null;
  autoplay = false;
  muted = true;
  playing = false;
  removed = false;
  static playImpl: (() => Promise<void>) | null = null;
  play() {
    const impl = FakeAudioEl.playImpl;
    if (impl)
      return impl().then(() => {
        this.playing = true;
      });
    this.playing = true;
    return Promise.resolve();
  }
  pause() {
    this.playing = false;
  }
  setAttribute() {}
  remove() {
    this.removed = true;
  }
}

export function createWorld(serverOpts: FakeServerOptions = {}) {
  const clock = new FakeClock();
  const server = new FakeSignalingServer(clock, serverOpts);
  const rtc = createFakeRtc();
  return { clock, server, rtc };
}
export type World = ReturnType<typeof createWorld>;

export interface Participant {
  c: CallController & CallControllerInternals;
  deps: CoreDeps;
  devices: FakeMediaDevices;
  doc: FakeDocument;
  win: FakeWindow;
  audioEls: FakeAudioEl[];
  storage: Map<string, string>;
  qaTarget: { __clearcall?: unknown };
  replaceState: string[];
}

export function createParticipant(w: World, overrides: Partial<CoreDeps> = {}): Participant {
  const devices = new FakeMediaDevices();
  const doc = new FakeDocument();
  const win = new FakeWindow();
  const audioEls: FakeAudioEl[] = [];
  const storage = new Map<string, string>();
  const qaTarget = {};
  const replaceState: string[] = [];
  const deps: CoreDeps = {
    clock: w.clock,
    random: () => 0.5,
    crypto: { available: true, generateSecret, generatePeerId, deriveRoomKeys, cipher: roomCipher },
    WebSocket: w.server.WebSocket,
    RTCPeerConnection: w.rtc.RTCPeerConnection,
    MediaStream: FakeMediaStream as unknown as typeof MediaStream,
    mediaDevices: devices,
    getCapabilities: () => null,
    mediaCapabilities: undefined,
    userAgent: "",
    device: {},
    location: {
      origin: "https://cc.test",
      protocol: "https:",
      host: "cc.test",
      search: "?qa=1",
      href: "https://cc.test/",
    },
    history: { replaceState: (_d, _u, url) => replaceState.push(url) },
    document: doc,
    window: win,
    navigator: {},
    fetch: undefined,
    storage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => {
        storage.set(k, v);
      },
    },
    createAudioContext: undefined,
    createAudioElement: () => {
      const el = new FakeAudioEl();
      audioEls.push(el);
      return el;
    },
    MediaRecorder: undefined,
    PerformanceObserver: undefined,
    performance: undefined,
    isSecureContext: true,
    qaTarget,
    flags: { red: false, debug: false, qa: true, telemetry: false },
    ...overrides,
  };
  const c = createCallController(deps);
  return { c, deps, devices, doc, win, audioEls, storage, qaTarget, replaceState };
}
