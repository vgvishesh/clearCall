/**
 * Full-mesh transport (ADR-0005/0006): one PeerSession per remote peer, roster + hello/resume semantics from
 * protocol/FLOWS.md, per-peer serialized signal queue, `ctl` state/view/bye, policy inputs.
 *
 * Roles (FLOWS §2): whoever learned about the other from the *first* `welcome.peers` offers; peers learned via
 * `peer-joined` (or first seen in a resumed welcome, i.e. joined while we were away) are answered. Roles never
 * change for the life of the roster entry, so both sides always agree. A `hello` on a pair that has already
 * exchanged sdp/ice means the peer rebuilt its side → discard and recreate ours (no hello reply, which would loop).
 * Pairs whose negotiation stalled (offer/answer lost) are rebuilt with a hello; ICE restart is only for pairs that
 * negotiated (PeerSession decides).
 */
import type { ErrorCode, PeerMessage, SignalPayload } from "@clearcall/protocol";
import type { Clock, TimerHandle } from "../clock.ts";
import type { CodecLike, CodecPrefs } from "../codecs.ts";
import { errInfo, type Logger, nullLogger, short } from "../log.ts";
import { type LocalTracks, type PeerRole, PeerSession } from "../peer-session.ts";
import { viewChanged, viewToReport } from "../policy.ts";
import { SerialQueue } from "../serial-queue.ts";
import type { WelcomeInfo } from "../signaling-client.ts";
import { summarizePeerStats } from "../stats.ts";
import type { QaPeerStats } from "../types.ts";
import type { LocalAnnounce, MediaTransport, RemoteInfo } from "./types.ts";

type Learned = "welcome" | "peer-joined";
type Hidden = null | "probing" | "away";

/**
 * How long a never-heard welcome peer stays hidden while we wait for `unknown-peer` (ghost) or any signal (alive).
 * Both arrive within one signaling round trip, so this only bounds the wait for a live peer whose hello is lost.
 */
export const PROBE_MS = 2_000;

interface Entry {
  id: string;
  learned: Learned;
  queue: SerialQueue;
  session: PeerSession | null;
  info: RemoteInfo;
  /** Listed in a `welcome.peers` (first or resumed). */
  fromWelcome: boolean;
  /** Any signal (hello/sdp/ice) has arrived from this peer since we learned it. */
  heard: boolean;
  /**
   * Hidden-until-heard (FLOWS §4/§5). A welcome-listed peer we never heard from is not shown yet:
   * - "probing": just learned; our hello is in flight. An active peer answers within a signaling round trip (and
   *   says hello on its own `peer-joined`); after PROBE_MS without `unknown-peer` it is shown anyway.
   * - "away": the server answered `unknown-peer` — typically our own previous peerId after a reload whose `leave`
   *   was lost. Kept in the roster (it may resume) but left out of `participants()` and the policy count.
   * Any signal from it shows it; `peer-left` drops it.
   */
  hidden: Hidden;
  probeTimer?: TimerHandle;
  /** Last view height we sent this peer (undefined = never). */
  viewSent?: number;
  /** Latest rendered tile height the UI reported for this peer. */
  tileHeight?: number;
  /** Interval-rate baselines per stats consumer. */
  statsPrev: Map<string, ReturnType<typeof summarizePeerStats>["raw"]>;
}

export interface MeshOptions {
  selfId: string;
  RTCPeerConnection: typeof RTCPeerConnection;
  MediaStream: typeof MediaStream;
  clock: Clock;
  sendSignal: (to: string, payload: SignalPayload) => void;
  /** Drop signals to `to` that were sent earlier but are still queued (socket down). Order-preserving. */
  discardQueued?: (to: string) => void;
  local: () => LocalTracks;
  /** Our announced state (name/mic/cam/mode) — read when a ctl channel opens and on hello. */
  announce: () => LocalAnnounce;
  codecPrefs?: CodecPrefs;
  getCapabilities?: (kind: "audio" | "video") => { codecs: CodecLike[] } | null;
  log?: Logger;
  /** Session tunables passthrough (tests). */
  sessionTunables?: Partial<{
    disconnectedGraceMs: number;
    politeExtraMs: number;
    maxRestarts: number;
    restartCheckMs: number;
    connectTimeoutMs: number;
    offerResendAfterMs: number;
  }>;
}

export class MeshTransport implements MediaTransport {
  readonly kind = "mesh" as const;
  private roster = new Map<string, Entry>();
  private iceServers: RTCIceServer[] = [];
  private up = false;
  private hidden = false;
  private listeners = new Set<() => void>();
  private closed = false;
  private lastAnnounce: string | null = null;
  private readonly log: Logger;

  constructor(private readonly o: MeshOptions) {
    this.log = o.log ?? nullLogger;
  }

  // ── presence ──

  welcome(info: WelcomeInfo, first: boolean): void {
    if (this.closed) return;
    this.iceServers = info.iceServers as RTCIceServer[];
    this.up = true;
    if (first || !info.resumed) {
      if (!first) {
        this.log.warn("resume window expired: rebuilding all pairs", { n: this.roster.size });
        for (const id of [...this.roster.keys()]) this.drop(id);
      }
      for (const id of info.peers) this.learn(id, "welcome", true);
      this.changed();
      return;
    }
    // Resumed: diff (FLOWS §4).
    const listed = new Set(info.peers);
    for (const id of [...this.roster.keys()]) if (!listed.has(id)) this.drop(id);
    for (const id of info.peers) {
      const e = this.roster.get(id);
      // Unknown here = it joined while we were away (we missed its peer-joined): it learned us from its
      // welcome.peers, so it is the offerer and we answer (FLOWS §2). Our hello makes it (re)offer.
      if (!e) this.learn(id, "peer-joined", true);
      else if (!e.session?.healthy) {
        // Not connected and not connecting with a completed negotiation (e.g. an offer lost in the drop):
        // rebuild via hello, keeping the role both sides agree on (FLOWS §2/§4).
        this.log.info("resume: re-pairing", {
          peer: short(id),
          role: this.roleFor(e),
          state: e.session ? e.session.pc.signalingState : "none",
        });
        this.rebuild(e, true);
      }
    }
    for (const e of this.roster.values()) e.session?.onSignalingRestored();
    this.changed();
  }

  peerJoined(id: string): void {
    if (this.closed || id === this.o.selfId) return;
    const existing = this.roster.get(id);
    if (existing) {
      // Fresh join with an id we hold (grace expired on their side): rebuild as answerer.
      existing.learned = "peer-joined";
      existing.fromWelcome = false;
      this.show(existing, "peer-joined"); // the server says it is active
      this.rebuild(existing, true);
      this.changed();
      return;
    }
    this.learn(id, "peer-joined");
    this.changed();
  }

  peerLeft(id: string, reason: "left" | "timeout"): void {
    if (!this.roster.has(id)) return;
    this.log.info("peer left", { peer: short(id), reason });
    this.drop(id);
    this.changed();
  }

  signal(from: string, payload: SignalPayload): void {
    if (this.closed) return;
    const e = this.roster.get(from);
    if (!e) {
      // FLOWS §2: hello from a peer not in the roster is ignored until peer-joined.
      this.log.debug("signal from unknown peer ignored", { peer: short(from), kind: payload.k });
      return;
    }
    e.heard = true;
    this.show(e, payload.k);
    void e.queue.push(async () => {
      if (this.roster.get(from) !== e) return;
      if (payload.k === "hello") {
        if (payload.name) this.update(e, { name: payload.name });
        if (e.session && !e.session.pristine) {
          this.log.info("hello on a used pair: reset", { peer: short(from) });
          // Keep what's queued behind the hello: it is for the peer's fresh pc (e.g. its new offer).
          this.rebuild(e, false, { keepQueue: true });
        } else if (!e.session) this.createSession(e);
        else e.session.onPeerHello(); // pristine pair: the peer may have rebuilt while our offer was lost
        return;
      }
      if (!e.session) this.createSession(e);
      await e.session!.handleSignal(payload);
    });
  }

  signalingError(code: ErrorCode, peerId?: string): void {
    if (code !== "unknown-peer" || !peerId) return;
    const e = this.roster.get(peerId);
    if (!e) return;
    // The peer is away/unknown to the server: drop queued work; keep a live media path, else wait for its hello.
    e.queue.clear();
    if (e.fromWelcome && !e.heard && e.hidden !== "away" && !e.session?.connected) {
      // Never heard from and unknown to the server: most likely our own ghost from before a reload. Hide it
      // until it signals (a resuming peer hellos everyone it has no pair with) or the server says it left.
      this.log.info("unknown-peer from a never-heard welcome peer: hiding it", { peer: short(peerId) });
      this.o.clock.clearTimeout(e.probeTimer);
      e.hidden = "away";
      this.updateParticipantCount();
      this.changed(); // visibility or `resolving` changed
    }
    if (e.session && !e.session.connected) {
      this.log.info("unknown-peer: dropping unconnected pair until hello", { peer: short(peerId) });
      e.session.close();
      e.session = null;
      this.update(e, { status: "connecting" });
    }
  }

  signalingUp(up: boolean): void {
    this.up = up;
    if (up) for (const e of this.roster.values()) e.session?.onSignalingRestored();
  }

  // ── local ──

  setLocalTrack(kind: "audio" | "video", track: MediaStreamTrack | null): void {
    for (const e of this.roster.values()) void e.session?.setLocalTrack(kind, track);
  }

  setLocalState(state: LocalAnnounce): void {
    const key = JSON.stringify(state);
    const prev = this.lastAnnounce ? (JSON.parse(this.lastAnnounce) as LocalAnnounce) : null;
    if (key === this.lastAnnounce) return;
    this.lastAnnounce = key;
    if (prev && prev.mode !== state.mode)
      for (const e of this.roster.values()) e.session?.setMode(state.mode);
    this.broadcast({ k: "state", ...state });
  }

  // ── policy inputs ──

  reportView(id: string, heightPx: number): void {
    const e = this.roster.get(id);
    if (!e) return;
    e.tileHeight = heightPx;
    this.sendView(e);
  }

  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    for (const e of this.roster.values()) this.sendView(e);
  }

  private sendView(e: Entry, force = false) {
    if (e.tileHeight === undefined && !this.hidden) return;
    const v = viewToReport(e.tileHeight ?? 0, this.hidden);
    if (!force && !viewChanged(e.viewSent, v)) return;
    if (e.session?.sendCtl({ k: "view", height: v })) e.viewSent = v;
  }

  // ── remote ──

  participants(): RemoteInfo[] {
    return [...this.roster.values()].filter((e) => !e.hidden).map((e) => e.info);
  }

  /** True while a peer from the first welcome is still being probed (see `Entry.hidden`). */
  get resolving(): boolean {
    for (const e of this.roster.values()) if (e.hidden === "probing") return true;
    return false;
  }

  audioLevels(): Map<string, number> {
    const m = new Map<string, number>();
    for (const e of this.roster.values()) if (!e.hidden) m.set(e.id, e.session?.audioLevel() ?? 0);
    return m;
  }

  async stats(consumer = "qa"): Promise<QaPeerStats[]> {
    const entries = [...this.roster.values()];
    const out = await Promise.all(
      entries.map(async (e) => {
        const s = e.session;
        if (!s || s.isClosed) return null;
        try {
          const report = await s.getStats();
          const r = summarizePeerStats(
            report as unknown as Parameters<typeof summarizePeerStats>[0],
            { id: e.id, name: e.info.name, connectionState: s.pc.connectionState },
            this.o.clock.now(),
            e.statsPrev.get(consumer),
          );
          e.statsPrev.set(consumer, r.raw);
          if (r.quality !== e.info.quality && r.quality !== "unknown") this.update(e, { quality: r.quality });
          return r.stats;
        } catch (err) {
          this.log.debug("getStats failed", { peer: short(e.id), ...errInfo(err) });
          return null;
        }
      }),
    );
    return out.filter((x): x is QaPeerStats => x !== null);
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ── control ──

  retry(id: string): void {
    const e = this.roster.get(id);
    if (!e) return;
    this.log.info("retry", { peer: short(id) });
    this.rebuild(e, true);
  }

  restartIce(id?: string): void {
    for (const e of this.targets(id)) e.session?.restartIce("manual");
  }

  kill(id?: string): void {
    for (const e of this.targets(id)) e.session?.kill();
  }

  broadcast(msg: PeerMessage): void {
    for (const e of this.roster.values()) e.session?.sendCtl(msg);
  }

  close(opts: { bye?: boolean } = {}): void {
    if (this.closed) return;
    if (opts.bye) this.broadcast({ k: "bye" });
    this.closed = true;
    for (const id of [...this.roster.keys()]) this.drop(id);
    this.listeners.clear();
  }

  // ── internals ──

  private targets(id?: string): Entry[] {
    if (id) {
      const e = this.roster.get(id);
      return e ? [e] : [];
    }
    return [...this.roster.values()];
  }

  private learn(id: string, learned: Learned, fromWelcome = false) {
    if (id === this.o.selfId || this.roster.has(id)) return;
    const e: Entry = {
      id,
      learned,
      queue: new SerialQueue((err) =>
        this.log.warn("signal task failed", { peer: short(id), ...errInfo(err) }),
      ),
      session: null,
      fromWelcome,
      heard: false,
      hidden: fromWelcome ? "probing" : null,
      statsPrev: new Map(),
      info: {
        id,
        name: "",
        micOn: true,
        camOn: true,
        mode: "voice",
        stream: null,
        status: "connecting",
        quality: "unknown",
      },
    };
    this.roster.set(id, e);
    this.log.info("peer learned", {
      peer: short(id),
      from: learned,
      ...(fromWelcome ? { welcome: true } : {}),
    });
    if (fromWelcome)
      e.probeTimer = this.o.clock.setTimeout(() => {
        if (this.roster.get(id) === e && e.hidden === "probing") this.show(e, "probe-timeout");
      }, PROBE_MS);
    this.sayHello(id);
    this.createSession(e);
    this.updateParticipantCount();
  }

  private sayHello(id: string) {
    this.o.sendSignal(id, { k: "hello", name: this.o.announce().name });
  }

  private roleFor(e: Entry): PeerRole {
    return e.learned === "welcome" ? "offerer" : "answerer";
  }

  private createSession(e: Entry) {
    const id = e.id;
    const session = new PeerSession({
      selfId: this.o.selfId,
      remoteId: id,
      role: this.roleFor(e),
      RTCPeerConnection: this.o.RTCPeerConnection,
      MediaStream: this.o.MediaStream,
      clock: this.o.clock,
      iceServers: () => this.iceServers,
      local: this.o.local,
      isSignalingUp: () => this.up,
      sendSignal: (p) => {
        // A discarded pc's late candidates/descriptions would confuse the peer's fresh pair.
        if (e.session === session && !session.isClosed) this.o.sendSignal(id, p);
      },
      ...(this.o.codecPrefs ? { codecPrefs: this.o.codecPrefs } : {}),
      ...(this.o.getCapabilities ? { getCapabilities: this.o.getCapabilities } : {}),
      log: this.log,
      ...this.o.sessionTunables,
      events: {
        status: (status) => {
          if (e.session === session) this.update(e, { status });
        },
        stream: (stream) => {
          if (e.session === session) this.update(e, { stream });
        },
        ctlOpen: () => {
          if (e.session !== session) return;
          session.sendCtl({ k: "state", ...this.o.announce() });
          e.viewSent = undefined;
          this.sendView(e, true);
        },
        message: (m) => {
          if (e.session === session) this.onCtl(e, m);
        },
        dead: () => {
          // Injected kill: recover like a user Retry (FLOWS §6 retry semantics).
          if (e.session === session && !this.closed) this.o.clock.setTimeout(() => this.retry(id), 0);
        },
        stalled: (reason) => {
          // Offer/answer lost: discard and hello so the offerer (per role) negotiates from scratch (FLOWS §2).
          if (e.session !== session || this.closed) return;
          this.log.info("stalled pair: rebuilding", { peer: short(id), reason, role: this.roleFor(e) });
          this.rebuild(e, true);
        },
      },
    });
    e.session = session;
    session.setParticipants(this.participantCount());
    this.update(e, { status: "connecting", stream: null });
  }

  /** Discard the pair and create a fresh one; `hello` tells the peer to do the same (FLOWS §2). */
  private rebuild(e: Entry, sendHello: boolean, opts: { keepQueue?: boolean } = {}) {
    if (!opts.keepQueue) e.queue.clear();
    e.session?.close();
    e.session = null;
    e.statsPrev.clear();
    e.viewSent = undefined;
    // Signals for the old pc still waiting in the signaling outbox must not reach the peer's fresh pair.
    this.o.discardQueued?.(e.id);
    if (sendHello) this.sayHello(e.id);
    this.createSession(e);
  }

  private onCtl(e: Entry, m: PeerMessage) {
    switch (m.k) {
      case "state":
        this.update(e, { name: m.name, micOn: m.mic, camOn: m.cam, mode: m.mode });
        return;
      case "view":
        e.session?.setRemoteView(m.height);
        return;
      case "bye":
        this.log.info("bye", { peer: short(e.id) });
        this.drop(e.id);
        this.changed();
        return;
    }
  }

  private drop(id: string) {
    const e = this.roster.get(id);
    if (!e) return;
    e.queue.clear();
    this.o.clock.clearTimeout(e.probeTimer);
    e.session?.close();
    e.session = null;
    this.roster.delete(id);
    this.updateParticipantCount();
  }

  /** Us + every remote that is not a hidden away ghost (those don't cost us bandwidth tiers). */
  private participantCount(): number {
    let n = 1;
    for (const e of this.roster.values()) if (e.hidden !== "away") n++;
    return n;
  }

  private show(e: Entry, why: string) {
    if (e.hidden === null) return;
    this.o.clock.clearTimeout(e.probeTimer);
    if (e.hidden === "away") this.log.info("hidden peer is back: showing it", { peer: short(e.id), why });
    e.hidden = null;
    this.updateParticipantCount();
    this.changed();
  }

  private updateParticipantCount() {
    const n = this.participantCount();
    for (const e of this.roster.values()) e.session?.setParticipants(n);
  }

  private update(e: Entry, patch: Partial<RemoteInfo>) {
    let dirty = false;
    for (const [k, v] of Object.entries(patch) as [keyof RemoteInfo, unknown][]) {
      if (e.info[k] !== v) dirty = true;
    }
    if (!dirty) return;
    e.info = { ...e.info, ...patch };
    this.changed();
  }

  private changed() {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (err) {
        this.log.error("change listener threw", errInfo(err));
      }
    }
  }
}
