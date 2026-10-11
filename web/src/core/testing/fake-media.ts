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
