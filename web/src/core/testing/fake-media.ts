/** Fake navigator.mediaDevices + AudioContext + document visibility. Test-only. */
import { FakeMediaStream, FakeTrack } from "./fake-webrtc.ts";

export class FakeMediaDevices {
  /** Error name to throw per kind (e.g. "NotAllowedError"); applies to any request that includes that kind. */
  fail: { audio?: string; video?: string } = {};
  calls: MediaStreamConstraints[] = [];
  /** Live tracks we handed out (for the iOS "stop before re-acquire" assertion). */
  issued: FakeTrack[] = [];
  /** Requests made while a live track of the same kind existed (iOS would mute/end the old one). */
  overlaps: string[] = [];
  devices: { kind: MediaDeviceKind; deviceId: string; label: string; groupId: string }[] = [
    { kind: "audioinput", deviceId: "mic1", label: "Mic", groupId: "g" },
    { kind: "videoinput", deviceId: "cam1", label: "Front", groupId: "g" },
    { kind: "videoinput", deviceId: "cam2", label: "Back", groupId: "g" },
  ];
  /** When set, getUserMedia waits for it (simulates a slow camera start / permission prompt). */
  gate: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  async getUserMedia(c: MediaStreamConstraints): Promise<MediaStream> {
    this.calls.push(c);
    await Promise.resolve();
    if (this.gate) await this.gate;
    const err = (c.audio && this.fail.audio) || (c.video && this.fail.video);
    if (err) throw Object.assign(new Error(err), { name: err });
    const tracks: FakeTrack[] = [];
    for (const kind of ["audio", "video"] as const) {
      if (!c[kind]) continue;
      if (this.issued.some((t) => t.kind === kind && t.readyState === "live")) this.overlaps.push(kind);
      const facing = (c.video as MediaTrackConstraints | undefined)?.facingMode;
      const t = new FakeTrack(
        kind,
        `${kind}-dev`,
        kind === "video" ? { width: 1280, height: 720, facingMode: facing ?? "user" } : { deviceId: "mic1" },
      );
      this.issued.push(t);
      tracks.push(t);
    }
    return new FakeMediaStream(tracks) as unknown as MediaStream;
  }

  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return this.devices as unknown as MediaDeviceInfo[];
  }

  addEventListener(_t: "devicechange", fn: () => void) {
    this.listeners.add(fn);
  }
  removeEventListener(_t: "devicechange", fn: () => void) {
    this.listeners.delete(fn);
  }
  fireDeviceChange() {
    for (const fn of this.listeners) fn();
  }
  live(kind: "audio" | "video") {
    return this.issued.filter((t) => t.kind === kind && t.readyState === "live");
  }
}

export class FakeDocument {
  visibilityState: "visible" | "hidden" = "visible";
  private listeners = new Set<() => void>();
  addEventListener(_t: "visibilitychange", fn: () => void) {
    this.listeners.add(fn);
  }
  removeEventListener(_t: "visibilitychange", fn: () => void) {
    this.listeners.delete(fn);
  }
  setVisibility(v: "visible" | "hidden") {
    this.visibilityState = v;
    for (const fn of this.listeners) fn();
  }
}

export class FakeAudioContext {
  state = "suspended";
  amplitude = 0;
  closed = false;
  async resume() {
    this.state = "running";
  }
  async close() {
    this.closed = true;
    this.state = "closed";
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createAnalyser() {
    return {
      fftSize: 2048,
      getFloatTimeDomainData: (a: Float32Array) => {
        for (let i = 0; i < a.length; i++) a[i] = this.amplitude * Math.sin(i / 3);
      },
    };
  }
}

export class FakePermissionStatus {
  private listeners = new Set<() => void>();
  constructor(public state: string) {}
  addEventListener(_t: "change", fn: () => void) {
    this.listeners.add(fn);
  }
  removeEventListener(_t: "change", fn: () => void) {
    this.listeners.delete(fn);
  }
  get listenerCount() {
    return this.listeners.size;
  }
  set(state: string) {
    this.state = state;
    for (const fn of this.listeners) fn();
  }
}

/**
 * Fake `navigator.permissions` for camera + microphone. `set(kind, state)` changes the state silently (as Safari does
 * after Settings); `change(kind, state)` also fires the `change` event. `throws` makes a name unsupported (Firefox).
 */
export class FakePermissions {
  readonly status: Record<"camera" | "microphone", FakePermissionStatus>;
  throws = new Set<string>();
  queries: string[] = [];
  /** When set, queries wait for it (a hanging webview). */
  gate: Promise<void> | null = null;
  constructor(camera = "granted", microphone = "granted") {
    this.status = {
      camera: new FakePermissionStatus(camera),
      microphone: new FakePermissionStatus(microphone),
    };
  }
  async query(d: { name: string }) {
    this.queries.push(d.name);
    if (this.gate) await this.gate;
    if (this.throws.has(d.name)) throw new TypeError(`'${d.name}' is not a valid PermissionName`);
    const s = this.status[d.name as "camera" | "microphone"];
    if (!s) throw new TypeError("bad name");
    return s;
  }
  set(kind: "camera" | "microphone", state: string) {
    this.status[kind].state = state;
  }
  change(kind: "camera" | "microphone", state: string) {
    this.status[kind].set(state);
  }
  setBoth(state: string) {
    this.set("camera", state);
    this.set("microphone", state);
  }
}
