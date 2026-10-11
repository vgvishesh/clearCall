/**
 * Fake WebRTC for unit tests (no browser). Models what our engine depends on:
 * - signaling state machine incl. implicit rollback, setLocalDescription() without args;
 * - transceivers + mids, with the spec rule that only addTrack-created transceivers are reused by a remote offer
 *   (so addTransceiver on both sides of a glare really produces extra m-lines, like browsers do);
 * - negotiationneeded, trickle candidates (one host candidate + end), restartIce → new ufrag;
 * - "connectivity": two fake pcs connect once each has the other's current-ufrag candidate and both descriptions;
 * - negotiated data channels pair by id and pass messages; senders with get/setParameters; receivers with SSRC levels.
 * Test-only.
 */

type Listener = (ev: unknown) => void;

class Emitter {
  private listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    this.listeners.set(type, set);
    set.add(fn);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }
  protected emit(type: string, ev: unknown = {}) {
    const on = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof on === "function") (on as Listener).call(this, ev);
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

let seq = 0;
const nextId = (p: string) => `${p}${++seq}`;

export class FakeTrack extends Emitter {
  readonly id = nextId("track-");
  enabled = true;
  readyState: "live" | "ended" = "live";
  muted = false;
  onended: Listener | null = null;
  onmute: Listener | null = null;
  onunmute: Listener | null = null;
  stopCalls = 0;
  constructor(
    readonly kind: "audio" | "video",
    readonly label = `${kind}-device`,
    public settings: Record<string, unknown> = kind === "video"
      ? { width: 1280, height: 720, facingMode: "user", deviceId: "cam1" }
      : { deviceId: "mic1" },
  ) {
    super();
  }
  stop() {
    this.stopCalls++;
    this.readyState = "ended";
  }
  getSettings() {
    return { ...this.settings };
  }
  getConstraints() {
    return {};
  }
  async applyConstraints() {}
  clone() {
    return new FakeTrack(this.kind, this.label, this.settings);
  }
  /** Simulate the OS ending the track (device unplugged, iOS background). */
  end() {
    this.readyState = "ended";
    this.emit("ended");
  }
  setMuted(m: boolean) {
    this.muted = m;
    this.emit(m ? "mute" : "unmute");
  }
}

export class FakeMediaStream extends Emitter {
  readonly id = nextId("stream-");
  private tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] | FakeMediaStream = []) {
    super();
    this.tracks = Array.isArray(tracks) ? [...tracks] : tracks.getTracks();
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(t: FakeTrack) {
    if (!this.tracks.includes(t)) this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

export class FakeSender {
  params: { transactionId: string; encodings: Record<string, unknown>[]; [k: string]: unknown } = {
    transactionId: "t0",
    encodings: [{}],
  };
  setParametersCalls: unknown[] = [];
  replaceTrackCalls: (FakeTrack | null)[] = [];
  streams: FakeMediaStream[] = [];
  constructor(public track: FakeTrack | null) {}
  async replaceTrack(t: FakeTrack | null) {
    this.replaceTrackCalls.push(t);
    this.track = t;
  }
  getParameters() {
    return structuredClone(this.params);
  }
  async setParameters(p: typeof this.params) {
    if (p.encodings.length !== this.params.encodings.length) throw new Error("InvalidModificationError");
    this.setParametersCalls.push(p);
    this.params = { ...structuredClone(p), transactionId: nextId("t") };
  }
  setStreams(...s: FakeMediaStream[]) {
    this.streams = s;
  }
}

export class FakeReceiver {
  readonly track: FakeTrack;
  audioLevel = 0;
  constructor(kind: "audio" | "video") {
    this.track = new FakeTrack(kind, `remote-${kind}`);
  }
  getSynchronizationSources() {
    return this.track.kind === "audio" ? [{ source: 1, timestamp: 0, audioLevel: this.audioLevel }] : [];
  }
}

type Direction = "sendrecv" | "sendonly" | "recvonly" | "inactive";

export class FakeTransceiver {
  mid: string | null = null;
  pendingMid: string | null = null;
  readonly sender: FakeSender;
  readonly receiver: FakeReceiver;
  currentDirection: Direction | null = null;
  codecPreferences: unknown[] | null = null;
  stopped = false;
  /** Direction as of the last completed negotiation (for negotiationneeded). */
  negotiatedDirection: Direction | null = null;
  trackFired = false;
  private _direction: Direction;
  constructor(
    private readonly pc: FakePeerConnection,
    readonly kind: "audio" | "video",
    direction: Direction,
    track: FakeTrack | null,
    readonly createdBy: "addTransceiver" | "remote",
  ) {
    this._direction = direction;
    this.sender = new FakeSender(track);
    this.receiver = new FakeReceiver(kind);
  }
  get direction() {
    return this._direction;
  }
  set direction(d: Direction) {
    this._direction = d;
    this.pc.updateNegotiationNeeded();
  }
  setCodecPreferences(c: unknown[]) {
    this.codecPreferences = c;
  }
  stop() {
    this.stopped = true;
  }
}

export class FakeDataChannel extends Emitter {
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onclose: Listener | null = null;
  onerror: Listener | null = null;
  peer: FakeDataChannel | null = null;
  sent: string[] = [];
  bufferedAmount = 0;
  constructor(
    readonly label: string,
    readonly id: number,
    readonly negotiated: boolean,
    readonly ordered = true,
  ) {
    super();
  }
  send(data: string) {
    if (this.readyState !== "open") throw new Error("InvalidStateError: channel not open");
    this.sent.push(data);
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer?.readyState === "open") peer.emit("message", { data });
    });
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    queueMicrotask(() => this.emit("close"));
    const p = this.peer;
    this.peer = null;
    if (p) p.close();
  }
  _open(peer: FakeDataChannel) {
    if (this.readyState !== "connecting") return;
    this.peer = peer;
    this.readyState = "open";
    queueMicrotask(() => this.emit("open"));
  }
}

interface MLine {
  kind: "audio" | "video" | "application";
  mid: string;
  direction: Direction;
}

function parseSdp(sdp: string): { ufrag: string; pcId: string; mlines: MLine[] } {
  const lines = sdp.split(/\r?\n/);
  const ufrag = lines.find((l) => l.startsWith("a=ice-ufrag:"))?.slice(12) ?? "";
  const pcId = lines.find((l) => l.startsWith("a=x-fake-pc:"))?.slice(12) ?? "";
  const mlines: MLine[] = [];
  let cur: MLine | null = null;
  for (const l of lines) {
    if (l.startsWith("m=")) {
      cur = { kind: l.slice(2).split(" ")[0] as MLine["kind"], mid: "", direction: "sendrecv" };
      mlines.push(cur);
    } else if (cur && l.startsWith("a=mid:")) cur.mid = l.slice(6);
    else if (cur && /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(l))
      cur.direction = l.slice(2) as Direction;
  }
  return { ufrag, pcId, mlines };
}

const reverse = (d: Direction): Direction =>
  d === "sendonly" ? "recvonly" : d === "recvonly" ? "sendonly" : d;

function intersect(local: Direction, remoteOffered: Direction): Direction {
  const remoteRecv = remoteOffered === "sendrecv" || remoteOffered === "recvonly";
  const remoteSend = remoteOffered === "sendrecv" || remoteOffered === "sendonly";
  const send = (local === "sendrecv" || local === "sendonly") && remoteRecv;
  const recv = (local === "sendrecv" || local === "recvonly") && remoteSend;
  return send && recv ? "sendrecv" : send ? "sendonly" : recv ? "recvonly" : "inactive";
}

export interface FakeRtcEnv {
  pcs: FakePeerConnection[];
  byUfrag: Map<string, FakePeerConnection>;
  /** While true, no new ICE connectivity is established (simulates a dead network). */
  blocked: boolean;
}

export type Desc = { type: "offer" | "answer" | "pranswer" | "rollback"; sdp?: string };

export class FakePeerConnection extends Emitter {
  readonly pcId = nextId("pc");
  signalingState: "stable" | "have-local-offer" | "have-remote-offer" | "closed" = "stable";
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  localDescription: Desc | null = null;
  remoteDescription: Desc | null = null;
  currentLocalDescription: Desc | null = null;
  currentRemoteDescription: Desc | null = null;
  onnegotiationneeded: Listener | null = null;
  onicecandidate: Listener | null = null;
  ontrack: Listener | null = null;
  onconnectionstatechange: Listener | null = null;
  oniceconnectionstatechange: Listener | null = null;
  onsignalingstatechange: Listener | null = null;
  ondatachannel: Listener | null = null;
  readonly transceivers: FakeTransceiver[] = [];
  readonly channels: FakeDataChannel[] = [];
  /** m-line order once negotiated: mids in order. */
  private mlineOrder: { mid: string; kind: MLine["kind"] }[] = [];
  private pendingMlineOrder: { mid: string; kind: MLine["kind"] }[] | null = null;
  private appMid: string | null = null;
  private nextMid = 0;
  ufrag = nextId("u");
  private iceRestartPending = false;
  private remoteUfrag: string | null = null;
  private addedUfrags = new Set<string>();
  private negotiationNeededQueued = false;
  config: RTCConfiguration;
  setConfigurationCalls: RTCConfiguration[] = [];
  restartIceCalls = 0;
  addTransceiverCalls = 0;
  /** Local offers discarded by a rollback (explicit, or implicit on a glaring remote offer). */
  localOfferRollbacks = 0;
  addedCandidates: unknown[] = [];
  sdpLog: { dir: "local" | "remote"; type: string; sdp: string }[] = [];
  /** Optional hook for getStats(). */
  statsFn: (() => Map<string, Record<string, unknown>>) | null = null;
  private version = 0;

  constructor(
    readonly env: FakeRtcEnv,
    config: RTCConfiguration = {},
  ) {
    super();
    this.config = { ...config };
    env.pcs.push(this);
  }

  getConfiguration() {
    return { ...this.config };
  }
  setConfiguration(c: RTCConfiguration) {
    this.setConfigurationCalls.push(c);
    this.config = { ...c };
  }

  addTransceiver(trackOrKind: FakeTrack | "audio" | "video", init: { direction?: Direction } = {}) {
    this.assertOpen();
    this.addTransceiverCalls++;
    const kind = typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
    const track = typeof trackOrKind === "string" ? null : trackOrKind;
    const t = new FakeTransceiver(this, kind, init.direction ?? "sendrecv", track, "addTransceiver");
    this.transceivers.push(t);
    this.updateNegotiationNeeded();
    return t;
  }

  getTransceivers() {
    return this.transceivers.filter((t) => !t.stopped);
  }
  getSenders() {
    return this.getTransceivers().map((t) => t.sender);
  }
  getReceivers() {
    return this.getTransceivers().map((t) => t.receiver);
  }

  createDataChannel(label: string, init: { negotiated?: boolean; id?: number; ordered?: boolean } = {}) {
    this.assertOpen();
    const ch = new FakeDataChannel(
      label,
      init.id ?? this.channels.length,
      !!init.negotiated,
      init.ordered ?? true,
    );
    this.channels.push(ch);
    this.updateNegotiationNeeded();
    if (this.connectionState === "connected") this.pairChannels();
    return ch;
  }

  restartIce() {
    this.restartIceCalls++;
    this.iceRestartPending = true;
    this.updateNegotiationNeeded();
  }

  /** Number of m-lines in the current local description (the invariant under test). */
  get mlineCount(): number {
    return this.localDescription?.sdp ? parseSdp(this.localDescription.sdp).mlines.length : 0;
  }

  private buildSdp(type: "offer" | "answer"): string {
    const lines = [
      "v=0",
      `o=- ${this.pcId.replace(/\D/g, "")} ${++this.version} IN IP4 127.0.0.1`,
      "s=-",
      "t=0 0",
      `a=ice-ufrag:${this.ufrag}`,
      `a=x-fake-pc:${this.pcId}`,
    ];
    const order = this.pendingMlineOrder ?? this.mlineOrder;
    const section = (kind: MLine["kind"], mid: string, dir: Direction) => {
      if (kind === "application") {
        lines.push("m=application 9 UDP/DTLS/SCTP webrtc-datachannel", `a=mid:${mid}`);
        return;
      }
      lines.push(
        `m=${kind} 9 UDP/TLS/RTP/SAVPF ${kind === "audio" ? "111" : "96"}`,
        `a=mid:${mid}`,
        `a=${dir}`,
      );
      if (kind === "audio") lines.push("a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10;useinbandfec=1");
      else lines.push("a=rtpmap:96 VP8/90000");
    };
    if (type === "answer") {
      const remote = parseSdp(this.remoteDescription!.sdp!);
      for (const m of remote.mlines) {
        if (m.kind === "application") section("application", m.mid, "sendrecv");
        else {
          const t = this.transceivers.find((x) => (x.mid ?? x.pendingMid) === m.mid)!;
          section(m.kind, m.mid, intersect(t.direction, m.direction));
        }
      }
      return `${lines.join("\r\n")}\r\n`;
    }
    for (const m of order) {
      if (m.kind === "application") section("application", m.mid, "sendrecv");
      else {
        const t = this.transceivers.find((x) => (x.mid ?? x.pendingMid) === m.mid);
        if (t) section(m.kind, m.mid, t.direction);
      }
    }
    return `${lines.join("\r\n")}\r\n`;
  }

  async createOffer(): Promise<Desc> {
    this.assertOpen();
    await Promise.resolve();
    if (this.iceRestartPending) {
      this.ufrag = nextId("u");
      this.env.byUfrag.set(this.ufrag, this);
      this.iceRestartPending = false;
    }
    const order = [...this.mlineOrder];
    for (const t of this.transceivers) {
      if (t.stopped || t.mid) continue;
      if (!t.pendingMid) t.pendingMid = String(this.nextMid++);
      if (!order.some((o) => o.mid === t.pendingMid)) order.push({ mid: t.pendingMid, kind: t.kind });
    }
    if (this.channels.length && !this.appMid && !order.some((o) => o.kind === "application")) {
      order.push({ mid: String(this.nextMid++), kind: "application" });
    }
    this.pendingMlineOrder = order;
    return { type: "offer", sdp: this.buildSdp("offer") };
  }

  async createAnswer(): Promise<Desc> {
    this.assertOpen();
    await Promise.resolve();
    if (this.signalingState !== "have-remote-offer") throw new Error("InvalidStateError: createAnswer");
    return { type: "answer", sdp: this.buildSdp("answer") };
  }

  async setLocalDescription(desc?: Desc): Promise<void> {
    this.assertOpen();
    if (!desc) {
      desc =
        this.signalingState === "have-remote-offer" || this.signalingState === "have-local-offer"
          ? this.signalingState === "have-remote-offer"
            ? await this.createAnswer()
            : await this.createOffer()
          : await this.createOffer();
    }
    await Promise.resolve();
    if (desc.type === "rollback") {
      this.rollback();
      return;
    }
    if (desc.type === "offer") {
      if (this.signalingState !== "stable" && this.signalingState !== "have-local-offer")
        throw new Error(`InvalidStateError: SLD(offer) in ${this.signalingState}`);
      this.localDescription = desc;
      this.sdpLog.push({ dir: "local", type: "offer", sdp: desc.sdp ?? "" });
      this.setSignalingState("have-local-offer");
    } else {
      if (this.signalingState !== "have-remote-offer")
        throw new Error(`InvalidStateError: SLD(answer) in ${this.signalingState}`);
      this.localDescription = desc;
      this.sdpLog.push({ dir: "local", type: "answer", sdp: desc.sdp ?? "" });
      this.completeNegotiation(parseSdp(this.remoteDescription!.sdp!).mlines, "answerer");
    }
    this.env.byUfrag.set(this.ufrag, this);
    this.gather();
  }

  async setRemoteDescription(desc: Desc): Promise<void> {
    this.assertOpen();
    await Promise.resolve();
    if (desc.type === "rollback") {
      this.rollback();
      return;
    }
    const parsed = parseSdp(desc.sdp ?? "");
    if (desc.type === "offer") {
      if (this.signalingState === "have-local-offer") this.rollback(); // implicit rollback
      if (this.signalingState !== "stable")
        throw new Error(`InvalidStateError: SRD(offer) in ${this.signalingState}`);
      this.remoteDescription = desc;
      this.sdpLog.push({ dir: "remote", type: "offer", sdp: desc.sdp ?? "" });
      this.noteRemoteUfrag(parsed.ufrag);
      for (const m of parsed.mlines) {
        if (m.kind === "application") {
          this.appMid = m.mid;
          continue;
        }
        let t = this.transceivers.find((x) => !x.stopped && x.mid === m.mid);
        if (!t) {
          // Spec: only addTrack-created transceivers may be reused; ours come from addTransceiver → always new.
          t = new FakeTransceiver(this, m.kind, "recvonly", null, "remote");
          this.transceivers.push(t);
          t.pendingMid = m.mid;
        }
        this.maybeFireTrack(t, reverse(m.direction));
      }
      this.pendingMlineOrder = parsed.mlines.map((m) => ({ mid: m.mid, kind: m.kind }));
      this.setSignalingState("have-remote-offer");
    } else {
      if (this.signalingState !== "have-local-offer")
        throw new Error(`InvalidStateError: SRD(answer) in ${this.signalingState}`);
      this.remoteDescription = desc;
      this.sdpLog.push({ dir: "remote", type: "answer", sdp: desc.sdp ?? "" });
      this.noteRemoteUfrag(parsed.ufrag);
      for (const m of parsed.mlines) {
        if (m.kind === "application") this.appMid = m.mid;
        const t = this.transceivers.find((x) => (x.mid ?? x.pendingMid) === m.mid);
        if (t) this.maybeFireTrack(t, reverse(m.direction));
      }
      this.completeNegotiation(parsed.mlines, "offerer");
    }
    this.checkConnectivity();
  }

  private noteRemoteUfrag(u: string) {
    if (this.remoteUfrag && this.remoteUfrag !== u && this.signalingState === "stable") {
      // Remote ICE restart → we restart too (new local ufrag in our answer).
      this.ufrag = nextId("u");
      this.env.byUfrag.set(this.ufrag, this);
    }
    this.remoteUfrag = u;
  }

  private maybeFireTrack(t: FakeTransceiver, localView: Direction) {
    const weReceive = localView === "recvonly" || localView === "sendrecv";
    if (!weReceive || t.trackFired) return;
    t.trackFired = true;
    queueMicrotask(() =>
      this.emit("track", { track: t.receiver.track, receiver: t.receiver, transceiver: t, streams: [] }),
    );
  }

  private completeNegotiation(mlines: MLine[], _role: "offerer" | "answerer") {
    for (const m of mlines) {
      const t = this.transceivers.find((x) => (x.mid ?? x.pendingMid) === m.mid);
      if (t) {
        t.mid = m.mid;
        t.pendingMid = null;
        t.negotiatedDirection = t.direction;
        t.currentDirection = intersect(t.direction, m.direction);
      }
      if (m.kind === "application") this.appMid = m.mid;
    }
    this.mlineOrder = mlines.map((m) => ({ mid: m.mid, kind: m.kind }));
    this.pendingMlineOrder = null;
    this.nextMid = Math.max(this.nextMid, ...mlines.map((m) => Number(m.mid) + 1).filter(Number.isFinite));
    this.currentLocalDescription = this.localDescription;
    this.currentRemoteDescription = this.remoteDescription;
    this.setSignalingState("stable");
    this.negotiationNeededQueued = false;
    this.updateNegotiationNeeded();
  }

  private rollback() {
    if (this.signalingState === "have-local-offer") this.localOfferRollbacks++;
    for (const t of this.transceivers) t.pendingMid = null;
    // Transceivers created by a remote offer that never completed are removed on rollback.
    for (const t of [...this.transceivers])
      if (t.createdBy === "remote" && !t.mid) this.transceivers.splice(this.transceivers.indexOf(t), 1);
    this.pendingMlineOrder = null;
    this.localDescription = this.currentLocalDescription;
    this.remoteDescription = this.currentRemoteDescription;
    this.setSignalingState("stable");
    this.negotiationNeededQueued = false;
    this.updateNegotiationNeeded();
  }

  private setSignalingState(s: FakePeerConnection["signalingState"]) {
    if (this.signalingState === s) return;
    this.signalingState = s;
    this.emit("signalingstatechange");
  }

  private isNegotiationNeeded(): boolean {
    if (this.signalingState === "closed") return false;
    if (this.iceRestartPending) return true;
    if (this.transceivers.some((t) => !t.stopped && !t.mid)) return true;
    if (this.channels.length && !this.appMid) return true;
    return this.transceivers.some(
      (t) => t.mid && t.negotiatedDirection !== null && t.direction !== t.negotiatedDirection,
    );
  }

  updateNegotiationNeeded() {
    if (this.signalingState !== "stable" || this.negotiationNeededQueued) return;
    if (!this.isNegotiationNeeded()) return;
    this.negotiationNeededQueued = true;
    queueMicrotask(() => {
      if (this.signalingState === "stable" && this.isNegotiationNeeded()) this.emit("negotiationneeded");
      else this.negotiationNeededQueued = false;
    });
  }

  private gather() {
    const ufrag = this.ufrag;
    // Browsers fire icecandidate from tasks, i.e. after the SLD promise resolved.
    globalThis.setTimeout(() => {
      if (this.signalingState === "closed") return;
      const cand = {
        candidate: `candidate:1 1 udp 2122260223 10.0.0.1 50000 typ host ufrag ${ufrag}`,
        sdpMid: "0",
        sdpMLineIndex: 0,
        usernameFragment: ufrag,
      };
      this.emit("icecandidate", { candidate: { ...cand, toJSON: () => cand } });
      this.emit("icecandidate", { candidate: null });
    }, 0);
  }

  async addIceCandidate(c?: { candidate?: string; usernameFragment?: string | null } | null): Promise<void> {
    this.assertOpen();
    await Promise.resolve();
    if (!this.remoteDescription) throw new Error("InvalidStateError: no remote description");
    if (!c?.candidate) return;
    const ufrag = c.usernameFragment ?? /ufrag (\S+)/.exec(c.candidate)?.[1] ?? "";
    if (this.remoteUfrag && ufrag !== this.remoteUfrag) throw new Error("OperationError: unknown ufrag");
    this.addedCandidates.push(c);
    this.addedUfrags.add(ufrag);
    this.checkConnectivity();
  }

  /** Connect when both sides hold each other's current ufrag candidate and descriptions. */
  checkConnectivity() {
    if (this.env.blocked || this.signalingState === "closed") return;
    if (!this.remoteUfrag || !this.localDescription || !this.remoteDescription) return;
    const peer = this.env.byUfrag.get(this.remoteUfrag);
    if (!peer || peer.signalingState === "closed" || peer.ufrag !== this.remoteUfrag) return;
    if (!this.addedUfrags.has(peer.ufrag) || !peer.addedUfrags.has(this.ufrag)) return;
    if (peer.remoteUfrag !== this.ufrag) return;
    if (this.connectionState !== "connected") this.setConnectionState("connected");
    if (peer.connectionState !== "connected") peer.setConnectionState("connected");
    this.pairChannels(peer);
  }

  private pairChannels(peer?: FakePeerConnection) {
    const other = peer ?? (this.remoteUfrag ? this.env.byUfrag.get(this.remoteUfrag) : undefined);
    if (!other) return;
    for (const ch of this.channels) {
      if (ch.readyState !== "connecting" || !this.appMid) continue;
      const match = other.channels.find(
        (x) => x.id === ch.id && x.readyState === "connecting" && other.appMid,
      );
      if (match) {
        ch._open(match);
        match._open(ch);
      }
    }
  }

  setConnectionState(s: RTCPeerConnectionState) {
    if (this.connectionState === s || this.signalingState === "closed") return;
    this.connectionState = s;
    this.iceConnectionState =
      s === "connected"
        ? "connected"
        : s === "failed"
          ? "failed"
          : s === "disconnected"
            ? "disconnected"
            : "checking";
    this.emit("iceconnectionstatechange");
    this.emit("connectionstatechange");
  }

  /** Test helper: network breaks for this pair (both sides observe `state`). */
  breakLink(state: "disconnected" | "failed" = "failed") {
    const peer = this.remoteUfrag ? this.env.byUfrag.get(this.remoteUfrag) : undefined;
    this.addedUfrags.clear();
    this.setConnectionState(state);
    if (peer) {
      peer.addedUfrags.clear();
      peer.setConnectionState(state);
    }
  }

  /**
   * Like Firefox (the strictest engine here): a getStats pending when the pc closes never settles (Chromium and
   * WebKit resolve it). On an already-closed pc it resolves, as in every engine.
   */
  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    const closedBefore = this.signalingState === "closed";
    await Promise.resolve();
    if (!closedBefore && this.signalingState === "closed") await new Promise<never>(() => {});
    return this.statsFn ? this.statsFn() : new Map();
  }

  close() {
    if (this.signalingState === "closed") return;
    this.signalingState = "closed";
    this.connectionState = "closed";
    for (const ch of this.channels) ch.close();
  }

  private assertOpen() {
    if (this.signalingState === "closed") throw new Error("InvalidStateError: closed");
  }
}

/** Fresh isolated fake WebRTC world. Constructors are cast to the DOM types the engine is typed against. */
export function createFakeRtc() {
  const env: FakeRtcEnv = { pcs: [], byUfrag: new Map(), blocked: false };
  class PC extends FakePeerConnection {
    constructor(config?: RTCConfiguration) {
      super(env, config);
    }
  }
  return {
    env,
    RTCPeerConnection: PC as unknown as typeof RTCPeerConnection,
    MediaStream: FakeMediaStream as unknown as typeof MediaStream,
    /** Latest pcs (cast back to the fake type for assertions). */
    pcs: () => env.pcs,
  };
}

export const asFake = (pc: unknown) => pc as FakePeerConnection;
