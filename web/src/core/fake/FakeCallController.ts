/**
 * FakeCallController: a CallController with no network and no real devices, for UI development
 * (`?fake=1&scenario=<name>`), screenshots and UI unit tests. Behaves plausibly: prepare → lobby, join → in-call
 * with scenario participants, leave → ended, toggles update state, retry recovers a failed peer.
 */
import { MAX_NAME_LENGTH } from "@clearcall/protocol";
import { type Signal, signal } from "@preact/signals";
import type { AudioMode, CallController, CallState, LocalParticipant, RemoteParticipant } from "../types.ts";
import { createFakeFeed, type FakeFeed } from "./fakeMedia.ts";

export interface FakeOptions {
  /** Initial state (merged over defaults). */
  initial?: Partial<Omit<CallState, "local">> & { local?: Partial<LocalParticipant> };
  /** Remote participants the fake "finds" when you join from the lobby. */
  onJoinParticipants?: RemoteSpec[];
  /** Create canvas feeds (default true; false in unit tests). */
  media?: boolean;
  /** Animate the local mic level (default true). */
  animateLevels?: boolean;
  joinDelayMs?: number;
}

export interface RemoteSpec {
  id: string;
  name: string;
  camOn?: boolean;
  micOn?: boolean;
  mode?: AudioMode;
  status?: RemoteParticipant["status"];
  quality?: RemoteParticipant["quality"];
  speaking?: boolean;
  portrait?: boolean;
  hue?: number;
  x?: number;
}

export const DEFAULT_LOCAL: LocalParticipant = {
  name: "",
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
};

export function emptyState(): CallState {
  return {
    phase: "idle",
    error: null,
    link: null,
    local: { ...DEFAULT_LOCAL },
    participants: [],
    activeSpeakerId: null,
    audioBlocked: false,
    joinedAt: null,
    endedAt: null,
    videoLimited: null,
  };
}

export class FakeCallController implements CallController {
  readonly state: Signal<CallState>;
  /** Last reported view height per participant (for tests). */
  readonly views = new Map<string, number>();
  /** Every method call, in order (for tests). */
  readonly calls: { method: string; args: unknown[] }[] = [];

  private feeds = new Map<string, FakeFeed>();
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  private readonly opts: FakeOptions;

  constructor(opts: FakeOptions = {}) {
    this.opts = opts;
    const base = emptyState();
    const init = opts.initial ?? {};
    this.state = signal<CallState>({ ...base, ...init, local: { ...base.local, ...init.local } });
    const s = this.state.peek();
    if (s.phase !== "idle" && s.local.camOn && s.local.camAvailable && !s.local.stream) {
      this.patchLocal({ stream: this.feed("self", { hue: 205, portrait: isPortraitDevice() }) });
    }
    if (s.participants.length) this.attachRemoteFeeds(s.participants);
    if (opts.animateLevels !== false) this.startLevels();
  }

  async prepare(opts: { link?: string; name?: string }): Promise<void> {
    this.log("prepare", opts);
    const link = opts.link ?? `${location.origin}/c#${randomSecret()}`;
    if (typeof history !== "undefined") {
      try {
        history.replaceState(
          null,
          "",
          // Keep ?fake=1&scenario=… so a reload stays on the fake engine.
          `/c${location.search}${link.includes("#") ? link.slice(link.indexOf("#")) : ""}`,
        );
      } catch {
        // Ignore (non-browser test env).
      }
    }
    const s = this.state.peek();
    const camOk = s.local.camAvailable;
    this.set({
      phase: "lobby",
      error: s.phase === "lobby" ? s.error : null,
      link,
      participants: [],
      activeSpeakerId: null,
      audioBlocked: false,
      joinedAt: null,
      endedAt: null,
      local: {
        ...s.local,
        name: opts.name ?? s.local.name,
        camOn: camOk && (s.phase === "ended" || s.phase === "error" ? true : s.local.camOn),
        stream: camOk
          ? (s.local.stream ?? this.feed("self", { hue: 205, portrait: isPortraitDevice() }))
          : null,
      },
    });
  }

  async join(name: string): Promise<void> {
    this.log("join", [name]);
    this.patchLocal({ name: name.slice(0, MAX_NAME_LENGTH) });
    this.set({ phase: "joining" });
    await delay(this.opts.joinDelayMs ?? 500);
    if (this.state.peek().phase !== "joining") return;
    const remotes = (this.opts.onJoinParticipants ?? []).map((r) => toRemote(r));
    this.attachRemoteFeeds(remotes);
    this.set({
      phase: "in-call",
      participants: remotes,
      joinedAt: Date.now(),
      activeSpeakerId: remotes.find((r) => r.speaking)?.id ?? null,
    });
  }

  leave(): void {
    this.log("leave", []);
    const s = this.state.peek();
    if (s.phase === "ended") return;
    for (const [id, f] of this.feeds) if (id !== "self") f.stop();
    this.set({
      phase: "ended",
      endedAt: Date.now(),
      participants: [],
      activeSpeakerId: null,
      audioBlocked: false,
      joinedAt: s.joinedAt ?? Date.now(),
    });
  }

  setMic(on: boolean): void {
    this.log("setMic", [on]);
    if (!this.state.peek().local.micAvailable) return;
    this.patchLocal({ micOn: on, audioLevel: on ? this.state.peek().local.audioLevel : 0, speaking: false });
  }

  async setCam(on: boolean): Promise<void> {
    this.log("setCam", [on]);
    const l = this.state.peek().local;
    if (!l.camAvailable) return;
    if (!on) {
      this.feeds.get("self")?.stop();
      this.feeds.delete("self");
      this.patchLocal({ camOn: false, stream: null });
    } else {
      this.patchLocal({ camOn: true, stream: this.feed("self", { hue: 205, portrait: isPortraitDevice() }) });
    }
  }

  async switchCamera(): Promise<void> {
    this.log("switchCamera", []);
    const l = this.state.peek().local;
    this.patchLocal({ facing: l.facing === "user" ? "environment" : "user" });
  }

  async setMode(mode: AudioMode): Promise<void> {
    this.log("setMode", [mode]);
    this.patchLocal({ mode });
  }

  setName(name: string): void {
    this.log("setName", [name]);
    this.patchLocal({ name: name.slice(0, MAX_NAME_LENGTH) });
  }

  reportView(participantId: string, heightPx: number): void {
    this.views.set(participantId, heightPx);
  }

  async resumeAudio(): Promise<void> {
    this.log("resumeAudio", []);
    this.set({ audioBlocked: false });
  }

  retryPeer(participantId: string): void {
    this.log("retryPeer", [participantId]);
    this.updateRemote(participantId, { status: "connecting" });
    setTimeout(() => this.updateRemote(participantId, { status: "connected", quality: "good" }), 1200);
  }

  async shareLink(): Promise<"shared" | "copied" | "cancelled"> {
    this.log("shareLink", []);
    const link = this.state.peek().link ?? "";
    try {
      await navigator.clipboard?.writeText(link);
    } catch {
      // Clipboard may be blocked in headless runs; the fake still reports a copy.
    }
    return "copied";
  }

  dispose(): void {
    clearInterval(this.levelTimer);
    for (const f of this.feeds.values()) f.stop();
    this.feeds.clear();
  }

  // ---- helpers ----
  private log(method: string, args: unknown) {
    this.calls.push({ method, args: Array.isArray(args) ? args : [args] });
  }

  private set(patch: Partial<CallState>) {
    this.state.value = { ...this.state.peek(), ...patch };
  }

  private patchLocal(patch: Partial<LocalParticipant>) {
    const s = this.state.peek();
    this.state.value = { ...s, local: { ...s.local, ...patch } };
  }

  private updateRemote(id: string, patch: Partial<RemoteParticipant>) {
    const s = this.state.peek();
    this.set({ participants: s.participants.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  }

  private feed(id: string, o: { hue: number; portrait?: boolean; x?: number }): MediaStream | null {
    if (this.opts.media === false) return null;
    const existing = this.feeds.get(id);
    if (existing) return existing.stream;
    const f = createFakeFeed(o);
    if (!f) return null;
    this.feeds.set(id, f);
    return f.stream;
  }

  private attachRemoteFeeds(remotes: RemoteParticipant[]) {
    const specs = new Map((this.opts.onJoinParticipants ?? []).map((r) => [r.id, r]));
    for (const r of remotes) {
      const spec = specs.get(r.id) ?? remoteSpecs.get(r.id);
      if (r.camOn && !r.stream)
        r.stream = this.feed(r.id, { hue: spec?.hue ?? hashHue(r.id), portrait: spec?.portrait, x: spec?.x });
    }
  }

  private startLevels() {
    let phase = 0;
    this.levelTimer = setInterval(() => {
      const s = this.state.peek();
      if (!s.local.micOn || !s.local.micAvailable || (s.phase !== "lobby" && s.phase !== "in-call")) return;
      phase += 0.35;
      // A speech-like envelope: syllables riding on slower phrases.
      const env = Math.max(0, Math.sin(phase * 0.5)) * (0.55 + 0.45 * Math.abs(Math.sin(phase * 2.3)));
      const level = Math.round(env * 100) / 100;
      this.patchLocal({ audioLevel: level, speaking: level > 0.3 });
    }, 100);
  }
}

/** Specs of remotes created from scenarios (so feeds match their look). */
export const remoteSpecs = new Map<string, RemoteSpec>();

export function toRemote(r: RemoteSpec): RemoteParticipant {
  remoteSpecs.set(r.id, r);
  return {
    id: r.id,
    name: r.name,
    micOn: r.micOn ?? true,
    camOn: r.camOn ?? true,
    mode: r.mode ?? "voice",
    stream: null,
    status: r.status ?? "connected",
    quality: r.quality ?? "good",
    audioLevel: r.speaking ? 0.6 : 0,
    speaking: r.speaking ?? false,
  };
}

function isPortraitDevice(): boolean {
  return (
    typeof matchMedia === "function" && matchMedia("(pointer: coarse) and (orientation: portrait)").matches
  );
}

function hashHue(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function randomSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
