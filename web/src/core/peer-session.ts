/**
 * One RTCPeerConnection to one remote peer (FLOWS.md §1, §2, §6).
 *
 * - Offerer (newcomer / learned the peer from `welcome.peers`): adds exactly one audio + one video transceiver
 *   (sendrecv) and the negotiated `ctl` channel up front → negotiationneeded → offer.
 * - Answerer: never calls addTransceiver. On the first offer: SRD, take the audio+video transceivers the offer
 *   created, set sendrecv + replaceTrack, create `ctl` (after SRD, so no extra negotiation), answer.
 *   ⇒ every pair has exactly 3 m-lines (audio, video, application), even after glare.
 * - Later renegotiations (mode change, ICE restart) use W3C perfect negotiation; polite = smaller peerId.
 *   Renegotiations both sides would start at the same moment (codec-tier change, ICE restart) are started by the
 *   impolite side only, with a delayed polite fallback: glare there is avoidable (see setParticipants).
 * - Initial glare (both sides think they are the offerer, e.g. after a resume): an offerer that has never completed
 *   a negotiation and receives an offer rebuilds itself as an answerer (polite, or impolite without an offer of its
 *   own in flight); the impolite side with an offer in flight ignores the remote offer. This keeps 3 m-lines.
 * - ICE restart: only the impolite side initiates (failed → now; disconnected > 4 s), with `setConfiguration`
 *   (fresh iceServers) before `restartIce()`. The polite side initiates only after a further 4 s of nothing
 *   happening. Max 3 restarts with backoff, then status "failed". Restarts wait while signaling is down.
 * - Camera on/off and mic mute never renegotiate (`replaceTrack` / `track.enabled`).
 */
import {
  CONTROL_CHANNEL_ID,
  CONTROL_CHANNEL_LABEL,
  type PeerMessage,
  parsePeerMessage,
  type SignalPayload,
} from "@clearcall/protocol";
import type { SendLevel } from "./adaptive.ts";
import type { Clock, TimerHandle } from "./clock.ts";
import { applyCodecPreferences, type CodecLike, type CodecPrefs, codecTier } from "./codecs.ts";
import { errInfo, type Logger, nullLogger, short } from "./log.ts";
import {
  audioPolicy,
  levelEligible,
  mergeAudioEncoding,
  mergeVideoEncoding,
  videoPolicy,
  videoStartBitrateKbps,
  withoutDegradation,
} from "./policy.ts";
import { mungeDescription, sdpOrigin, sdpSessionId, withVideoStartBitrate } from "./sdp.ts";
import type { AudioMode, PeerConnectionStatus } from "./types.ts";

export type PeerRole = "offerer" | "answerer";

export interface LocalTracks {
  audio: MediaStreamTrack | null;
  video: MediaStreamTrack | null;
  stream: MediaStream | null;
  mode: AudioMode;
  /** Short side of the camera capture (px), for the encode policy. */
  sourceShortSide?: number | undefined;
}

export interface PeerSessionEvents {
  status?(status: PeerConnectionStatus): void;
  /** Remote media stream (stable object per pc; a rebuilt pc emits a new one). */
  stream?(stream: MediaStream): void;
  message?(msg: PeerMessage): void;
  ctlOpen?(): void;
  /** The pc was closed from inside (kill / unrecoverable). */
  dead?(reason: string): void;
  /**
   * Negotiation never completed by the connect timeout (offer or answer lost in signaling): an ICE restart can't
   * help, the owner must discard the pair and send `hello` (FLOWS §2). Fired at most once per pc.
   */
  stalled?(reason: StallReason): void;
}

/**
 * `no-offer`: we never got/sent an offer · `no-answer`: an offer is outstanding with no answer ·
 * `no-connect`: answerer whose pair negotiated but never connected and the offerer didn't recover it.
 */
export type StallReason = "no-offer" | "no-answer" | "no-connect";

export interface PeerSessionOptions {
  selfId: string;
  remoteId: string;
  role: PeerRole;
  RTCPeerConnection: typeof RTCPeerConnection;
  MediaStream: typeof MediaStream;
  clock: Clock;
  /** Latest ICE servers from `welcome` (read on every (re)start). */
  iceServers: () => RTCIceServer[];
  /** `iceTransportPolicy: "relay"` — TURN only (`?relay=1`, TURN setup check). */
  relayOnly?: boolean;
  local: () => LocalTracks;
  sendSignal: (payload: SignalPayload) => void;
  isSignalingUp: () => boolean;
  codecPrefs?: CodecPrefs;
  getCapabilities?: (kind: "audio" | "video") => { codecs: CodecLike[] } | null;
  log?: Logger;
  events?: PeerSessionEvents;
  /** Tunables (ms). */
  disconnectedGraceMs?: number;
  politeExtraMs?: number;
  maxRestarts?: number;
  restartCheckMs?: number;
  connectTimeoutMs?: number;
  /** A peer hello re-sends our outstanding offer once it is at least this old. */
  offerResendAfterMs?: number;
}

export class PeerSession {
  readonly selfId: string;
  readonly remoteId: string;
  readonly polite: boolean;
  role: PeerRole;
  pc!: RTCPeerConnection;
  private ctl: RTCDataChannel | null = null;
  private audioTx: RTCRtpTransceiver | null = null;
  private videoTx: RTCRtpTransceiver | null = null;
  private remoteStream: MediaStream | null = null;
  private bound = false;
  private negotiatedOnce = false;
  private makingOffer = false;
  private ignoreOffer = false;
  private isSettingRemoteAnswerPending = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private _status: PeerConnectionStatus = "connecting";
  private everConnected = false;
  private restarts = 0;
  private restartTimer: TimerHandle | undefined;
  private connectTimer: TimerHandle | undefined;
  /** Polite side's fallback codec-tier offer (see setParticipants). */
  private tierTimer: TimerHandle | undefined;
  private restartWanted = false;
  /** The initial offer was deferred because signaling was down. */
  private offerWanted = false;
  private stallReported = false;
  private answererWaited = false;
  private offerSentAt = 0;
  /** ICE candidates this pc trickled (re-sent with a re-sent description). */
  private sentCandidates: SignalPayload[] = [];
  private remoteOffers = 0;
  private troubleSince: number | null = null;
  private closed = false;
  /** Rejecters of getStats calls pending on the current pc. */
  private readonly pendingStats = new Set<(reason: string) => void>();
  private _receivedSignal = false;
  private remoteView: number | undefined;
  private participants = 2;
  /** Adaptive send level to this peer (ADR-0008; the mesh decides it from stats). */
  private _sendLevel: SendLevel = "base";
  /** Video maxBitrate last applied to our sender (bps). */
  private _videoMaxBitrate: number | undefined;
  /** This engine rejected setParameters with a degradationPreference once: don't send it again. */
  private degradationUnsupported = false;
  private paramsTail: Promise<void> = Promise.resolve();
  private readonly o: PeerSessionOptions & {
    log: Logger;
    events: PeerSessionEvents;
    disconnectedGraceMs: number;
    politeExtraMs: number;
    maxRestarts: number;
    restartCheckMs: number;
    connectTimeoutMs: number;
    offerResendAfterMs: number;
  };

  constructor(opts: PeerSessionOptions) {
    this.o = {
      log: nullLogger,
      events: {},
      disconnectedGraceMs: 4000,
      politeExtraMs: 4000,
      maxRestarts: 3,
      restartCheckMs: 5000,
      connectTimeoutMs: 20_000,
      offerResendAfterMs: 3000,
      ...opts,
    } as PeerSession["o"];
    this.selfId = opts.selfId;
    this.remoteId = opts.remoteId;
    this.role = opts.role;
    this.polite = opts.selfId < opts.remoteId;
    this.createPc();
  }

  get status(): PeerConnectionStatus {
    return this._status;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** True until any sdp/ice has been received on this pair (a hello on a pristine pair doesn't reset it). */
  get pristine(): boolean {
    return !this._receivedSignal;
  }

  get connected(): boolean {
    return this._status === "connected";
  }

  /** Both a local and a remote description are applied (negotiation completed at least once on this pc). */
  get hasBothDescriptions(): boolean {
    return !!this.pc.localDescription && !!this.pc.remoteDescription;
  }

  /**
   * Worth keeping across a signaling resume (FLOWS §4): connected, or connecting with a completed negotiation.
   * A pair whose ICE is disconnected/failed is rebuilt via hello instead — while we were away the peer may have
   * dropped its side on `unknown-peer`, so an ICE restart could land on a pair that no longer exists.
   */
  get healthy(): boolean {
    if (this.closed || this._status === "failed") return false;
    if (this.connected) return true;
    const s = this.pc.connectionState;
    return this.hasBothDescriptions && (s === "new" || s === "connecting");
  }

  get stream(): MediaStream | null {
    return this.remoteStream;
  }

  get ctlOpen(): boolean {
    return this.ctl?.readyState === "open";
  }

  private get log() {
    return this.o.log;
  }

  private createPc() {
    const { RTCPeerConnection: PC, log } = this.o;
    const pc = new PC({
      iceServers: this.o.iceServers(),
      bundlePolicy: "max-bundle",
      ...(this.o.relayOnly ? { iceTransportPolicy: "relay" as const } : {}),
    });
    this.pc = pc;
    this.bound = false;
    this.negotiatedOnce = false;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;
    this.offerWanted = false;
    this.stallReported = false;
    this.answererWaited = false;
    this.sentCandidates = [];
    this.pendingCandidates = [];
    this.audioTx = this.videoTx = null;
    this.remoteStream = null;
    this.ctl = null;

    pc.onnegotiationneeded = () => {
      if (this.pc !== pc) return;
      void this.makeOffer("negotiationneeded");
    };
    pc.onicecandidate = (ev) => {
      if (this.pc !== pc || this.closed) return;
      const c = ev.candidate;
      if (!c) return; // end-of-candidates is implicit; some browsers choke on explicit null
      const init = (typeof c.toJSON === "function" ? c.toJSON() : c) as RTCIceCandidateInit;
      const payload: SignalPayload = {
        k: "ice",
        candidate: {
          candidate: init.candidate ?? "",
          sdpMid: init.sdpMid ?? null,
          sdpMLineIndex: init.sdpMLineIndex ?? null,
          usernameFragment: init.usernameFragment ?? null,
        },
      };
      // Kept (for this pc's current ufrag) so a re-sent description can carry them again.
      if (this.sentCandidates.length < 50) this.sentCandidates.push(payload);
      this.o.sendSignal(payload);
    };
    pc.ontrack = (ev) => {
      if (this.pc !== pc) return;
      this.ensureRemoteStream();
      const s = this.remoteStream!;
      if (!s.getTracks().includes(ev.track)) s.addTrack(ev.track);
      log.info("track", { peer: short(this.remoteId), kind: ev.track.kind });
      this.o.events.stream?.(s);
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      this.onConnectionState(pc.connectionState);
    };
    pc.onsignalingstatechange = () => {
      if (this.pc !== pc) return;
      log.debug("signaling state", { peer: short(this.remoteId), state: pc.signalingState });
      if (pc.signalingState === "stable" && this.bound) void this.applyEncodings();
    };

    if (this.role === "offerer") this.bindAsOfferer();
    this.armConnectTimer();
    log.info("pc created", { peer: short(this.remoteId), role: this.role, polite: this.polite });
  }

  private ensureRemoteStream() {
    if (!this.remoteStream) this.remoteStream = new this.o.MediaStream();
  }

  private bindAsOfferer() {
    const local = this.o.local();
    const streams = local.stream ? [local.stream] : [];
    this.audioTx = this.pc.addTransceiver(local.audio ?? "audio", { direction: "sendrecv", streams });
    this.videoTx = this.pc.addTransceiver(local.video ?? "video", { direction: "sendrecv", streams });
    this.applyCodecs();
    this.openCtl();
    this.bound = true;
  }

  /** After SRD(first offer): reuse the offer's transceivers, exactly one audio + one video. */
  private bindAsAnswerer() {
    const local = this.o.local();
    for (const t of this.pc.getTransceivers()) {
      const kind = t.receiver.track.kind;
      if (kind === "audio" && !this.audioTx) this.audioTx = t;
      else if (kind === "video" && !this.videoTx) this.videoTx = t;
    }
    for (const [t, track] of [
      [this.audioTx, local.audio],
      [this.videoTx, local.video],
    ] as const) {
      if (!t) continue;
      t.direction = "sendrecv";
      void t.sender.replaceTrack(track).catch((e) => this.log.warn("replaceTrack failed", errInfo(e)));
      const sender = t.sender as RTCRtpSender & { setStreams?: (...s: MediaStream[]) => void };
      if (local.stream && typeof sender.setStreams === "function") {
        try {
          sender.setStreams(local.stream);
        } catch {}
      }
    }
    if (!this.audioTx || !this.videoTx)
      this.log.warn("offer lacks audio/video m-line", { audio: !!this.audioTx, video: !!this.videoTx });
    this.applyCodecs();
    this.openCtl();
    this.bound = true;
    this.armConnectTimer(); // ICE starts now: give it the full window from the offer, not from pc creation
  }

  private applyCodecs() {
    const prefs = this.o.codecPrefs;
    const caps = this.o.getCapabilities;
    if (!prefs || !caps) return;
    if (this.audioTx) applyCodecPreferences(this.audioTx, "audio", caps("audio"), prefs, this.log);
    if (this.videoTx)
      applyCodecPreferences(this.videoTx, "video", caps("video"), prefs, this.log, this.participants);
  }

  private openCtl() {
    const ch = this.pc.createDataChannel(CONTROL_CHANNEL_LABEL, {
      negotiated: true,
      id: CONTROL_CHANNEL_ID,
      ordered: true,
    });
    this.ctl = ch;
    ch.onopen = () => {
      if (this.ctl !== ch) return;
      this.log.info("ctl open", { peer: short(this.remoteId) });
      this.o.events.ctlOpen?.();
    };
    ch.onmessage = (ev) => {
      if (this.ctl !== ch) return;
      const msg = parsePeerMessage(ev.data);
      if (msg) this.o.events.message?.(msg);
    };
    ch.onclose = () => {
      if (this.ctl === ch) this.log.debug("ctl closed", { peer: short(this.remoteId) });
    };
  }

  // ── negotiation ──

  private async makeOffer(reason: string): Promise<void> {
    const pc = this.pc;
    if (this.closed || !this.bound) return; // answerer before the first offer never offers
    if (!this.o.isSignalingUp()) {
      this.log.info("offer deferred: signaling down", { peer: short(this.remoteId) });
      this.restartWanted = this.restartWanted || reason === "ice-restart";
      // negotiationneeded won't fire again by itself: remember to offer once signaling is back.
      if (!pc.localDescription) this.offerWanted = true;
      return;
    }
    try {
      this.makingOffer = true;
      const offer = await pc.createOffer();
      if (this.pc !== pc || pc.signalingState !== "stable") return;
      await this.setLocal(pc, this.withVideoStart(offer));
      if (this.pc !== pc) return;
      this.log.info("offer sent", { peer: short(this.remoteId), reason });
      this.offerSentAt = this.o.clock.now();
      this.sendDescription(pc);
    } catch (e) {
      this.log.warn("offer failed", { peer: short(this.remoteId), ...errInfo(e) });
    } finally {
      if (this.pc === pc) this.makingOffer = false;
    }
  }

  private async setLocal(pc: RTCPeerConnection, desc: RTCSessionDescriptionInit) {
    const munged = mungeDescription(
      desc as { type: RTCSdpType; sdp?: string },
      this.o.local().mode,
      this.o.codecPrefs?.audio,
    );
    try {
      await pc.setLocalDescription(munged);
    } catch (e) {
      // Some browsers reject munged local SDP; fall back to the browser's own description.
      if (munged.sdp === desc.sdp || this.pc !== pc) throw e;
      this.log.warn("munged SLD rejected, using plain", errInfo(e));
      await pc.setLocalDescription(desc);
    }
  }

  /** Video start bitrate (policy per participant count; `?vstart=` lab override) on a description. */
  private withVideoStart<T extends { type: RTCSdpType; sdp?: string | undefined }>(desc: T): T {
    return withVideoStartBitrate(
      desc,
      videoStartBitrateKbps(this.participants, this.o.codecPrefs?.videoStartKbps),
    );
  }

  private sendDescription(pc: RTCPeerConnection) {
    const d = pc.localDescription;
    if (!d) return;
    this.o.sendSignal({ k: "sdp", description: { type: d.type, sdp: d.sdp } });
  }

  /** Re-send our current description plus the candidates trickled for it (they were probably lost too). */
  private resendDescription(pc: RTCPeerConnection) {
    this.sendDescription(pc);
    for (const c of this.sentCandidates) this.o.sendSignal(c);
  }

  /** Handle one sdp/ice payload. Called serially by the transport's per-peer queue. */
  async handleSignal(payload: SignalPayload): Promise<void> {
    if (this.closed) return;
    if (payload.k === "sdp") await this.handleDescription(payload.description);
    else if (payload.k === "ice") await this.handleCandidate(payload.candidate);
  }

  private async handleDescription(desc: { type: RTCSdpType; sdp: string }) {
    this._receivedSignal = true;
    let pc = this.pc;
    if (desc.type === "answer" && pc.signalingState === "stable") {
      // Duplicate (we re-sent an offer after a hello) or stale: there's no offer of ours to answer.
      this.log.debug("answer without an outstanding offer ignored", { peer: short(this.remoteId) });
      return;
    }
    if (
      desc.type === "offer" &&
      pc.signalingState === "stable" &&
      pc.localDescription?.type === "answer" &&
      pc.remoteDescription?.sdp !== undefined &&
      sdpOrigin(desc.sdp) === sdpOrigin(pc.remoteDescription.sdp)
    ) {
      // The very offer we already answered (re-sent by the offerer after our hello): our answer may have been
      // lost, so answer again with the same description. Idempotent.
      this.log.info("duplicate offer: re-sending answer", { peer: short(this.remoteId) });
      this.resendDescription(pc);
      return;
    }
    if (desc.type === "offer") this.remoteOffers++;
    const offerCollision =
      desc.type === "offer" &&
      (this.makingOffer || (pc.signalingState !== "stable" && !this.isSettingRemoteAnswerPending));

    const remoteSession = sdpSessionId(pc.remoteDescription?.sdp);
    if (
      desc.type === "offer" &&
      this.role === "answerer" &&
      remoteSession !== null &&
      sdpSessionId(desc.sdp) !== remoteSession
    ) {
      // The remote side replaced its pc (rebuilt pair whose hello we never saw): a renegotiation on our old pc
      // can't work (new DTLS/ICE identity). Start over as the answerer — keeps exactly 3 m-lines.
      this.log.info("offer from a replaced remote pc: rebuilding as answerer", {
        peer: short(this.remoteId),
      });
      this.rebuild("answerer", { fresh: true });
      pc = this.pc;
    } else if (desc.type === "offer" && this.role === "offerer" && !this.negotiatedOnce) {
      // Initial glare: both sides added transceivers. Never let both sets survive (3 m-line invariant).
      if (!this.polite && offerCollision) {
        this.ignoreOffer = true;
        this.log.info("initial glare: ignoring offer (impolite)", { peer: short(this.remoteId) });
        return;
      }
      this.log.info("initial glare: rebuilding as answerer", {
        peer: short(this.remoteId),
        polite: this.polite,
      });
      this.rebuild("answerer");
      pc = this.pc;
    } else {
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) {
        this.log.info("glare: ignoring offer (impolite)", { peer: short(this.remoteId) });
        return;
      }
    }

    desc = this.withVideoStart(desc); // our sender's start bitrate comes from the remote description

    try {
      this.isSettingRemoteAnswerPending = desc.type === "answer";
      await pc.setRemoteDescription(mungeDescription(desc, this.o.local().mode, this.o.codecPrefs?.audio)); // implicit rollback if needed
    } catch (e) {
      this.log.warn("setRemoteDescription failed", {
        peer: short(this.remoteId),
        type: desc.type,
        ...errInfo(e),
      });
      return;
    } finally {
      if (this.pc === pc) this.isSettingRemoteAnswerPending = false;
    }
    if (this.pc !== pc || this.closed) return;
    if (desc.type === "answer") this.negotiatedOnce = true;
    await this.flushCandidates(pc);

    if (desc.type === "offer") {
      if (!this.bound) this.bindAsAnswerer();
      try {
        const answer = await pc.createAnswer();
        if (this.pc !== pc) return;
        await this.setLocal(pc, this.withVideoStart(answer));
        if (this.pc !== pc) return;
        this.negotiatedOnce = true;
        this.sendDescription(pc);
        this.log.info("answer sent", { peer: short(this.remoteId) });
      } catch (e) {
        this.log.warn("answer failed", { peer: short(this.remoteId), ...errInfo(e) });
      }
    }
  }

  private async handleCandidate(c: RTCIceCandidateInit | null) {
    this._receivedSignal = true;
    if (!c?.candidate) return;
    const pc = this.pc;
    if (!pc.remoteDescription) {
      this.pendingCandidates.push(c);
      return;
    }
    try {
      await pc.addIceCandidate(c);
    } catch (e) {
      if (!this.ignoreOffer)
        this.log.debug("addIceCandidate failed", { peer: short(this.remoteId), ...errInfo(e) });
    }
  }

  private async flushCandidates(pc: RTCPeerConnection) {
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of pending) {
      try {
        await pc.addIceCandidate(c);
      } catch (e) {
        this.log.debug("queued candidate rejected", errInfo(e));
      }
    }
  }

  /**
   * Replace this pc with a fresh one (initial glare; `fresh` = the remote replaced its pc, so connection history
   * and restart budget start over too).
   */
  private rebuild(role: PeerRole, opts: { fresh?: boolean } = {}) {
    if (opts.fresh) {
      this.restarts = 0;
      this.troubleSince = null;
      this.restartWanted = false;
      if (this.everConnected) this.setStatus("reconnecting");
      this.everConnected = false;
    }
    const old = this.pc;
    this.role = role;
    old.onnegotiationneeded = old.onicecandidate = old.ontrack = null;
    old.onconnectionstatechange = old.onsignalingstatechange = null;
    try {
      this.ctl?.close();
    } catch {}
    try {
      old.close();
    } catch {}
    this.abortPendingStats("pc replaced");
    this.clearTimers();
    // Candidates that arrived before the offer belong to the remote pc we're about to answer: keep them.
    const carried = this.pendingCandidates;
    this.createPc();
    this.pendingCandidates = carried;
  }

  // ── connection state & ICE restart ──

  private setStatus(s: PeerConnectionStatus) {
    if (this._status === s) return;
    this._status = s;
    this.log.info("status", { peer: short(this.remoteId), status: s });
    this.o.events.status?.(s);
  }

  private armConnectTimer() {
    this.o.clock.clearTimeout(this.connectTimer);
    this.connectTimer = this.o.clock.setTimeout(() => {
      if (this.closed || this.connected) return;
      const pc = this.pc;
      this.log.warn("connect timeout", {
        peer: short(this.remoteId),
        state: pc.connectionState,
        signaling: pc.signalingState,
      });
      if (this.everConnected || (this.hasBothDescriptions && this.role === "offerer")) {
        this.onTrouble("failed"); // ICE problem: restart (FLOWS §6)
        return;
      }
      if (this.hasBothDescriptions) {
        // Answerer of a pair that never connected: the offerer drives recovery (restart, or rebuild if our
        // answer was lost). Acting at the same moment would cross its hello with a stale offer from this pc.
        if (!this.answererWaited) {
          this.answererWaited = true;
          this.armConnectTimer();
        } else this.reportStall("no-connect");
        return;
      }
      // Negotiation never completed: the offer or answer was lost. Restarting ICE can't help (FLOWS §2 rebuild).
      if (!this.o.isSignalingUp()) {
        this.armConnectTimer(); // the resume diff rebuilds it; check again later otherwise
        return;
      }
      this.reportStall(pc.localDescription && !pc.remoteDescription ? "no-answer" : "no-offer");
    }, this.o.connectTimeoutMs);
  }

  private reportStall(reason: StallReason) {
    if (this.stallReported || this.closed) return;
    this.stallReported = true;
    this.log.warn("negotiation stalled: pair needs a rebuild", {
      peer: short(this.remoteId),
      reason,
      role: this.role,
      signaling: this.pc.signalingState,
    });
    if (this.o.events.stalled) this.o.events.stalled(reason);
    else this.onTrouble("failed"); // no owner to rebuild: fall back to the restart path
  }

  private onConnectionState(state: RTCPeerConnectionState) {
    this.log.info("connection state", { peer: short(this.remoteId), state, restarts: this.restarts });
    if (state === "connected") {
      this.everConnected = true;
      this.restarts = 0;
      this.troubleSince = null;
      this.restartWanted = false;
      this.clearTimers();
      this.setStatus("connected");
      void this.applyEncodings();
    } else if (state === "disconnected" || state === "failed") {
      this.onTrouble(state);
    }
  }

  private onTrouble(kind: "disconnected" | "failed") {
    if (this.closed || this._status === "failed") return;
    // Before the first connect only the offerer drives recovery; the answerer's connect timer is its fallback.
    if (!this.everConnected && this.role === "answerer") return;
    if (this.everConnected) this.setStatus("reconnecting");
    if (this.troubleSince === null) this.troubleSince = this.o.clock.now();
    const offersBefore = this.remoteOffers;
    let delay = kind === "failed" ? 0 : this.o.disconnectedGraceMs;
    if (this.polite) delay = Math.max(delay, this.o.disconnectedGraceMs) + this.o.politeExtraMs;
    this.o.clock.clearTimeout(this.restartTimer);
    this.restartTimer = this.o.clock.setTimeout(() => {
      if (this.closed || this.connected) return;
      // Polite: only if nothing happened meanwhile (the impolite side's restart offer would count).
      if (this.polite && this.remoteOffers > offersBefore) {
        this.scheduleCheck();
        return;
      }
      this.restartIce("auto");
    }, delay);
  }

  /** Run the ICE-restart procedure now (also `QaHook.inject("restart-ice")`). */
  restartIce(reason: "auto" | "manual" = "manual"): void {
    if (this.closed) return;
    if (!this.o.isSignalingUp()) {
      this.restartWanted = true;
      this.log.info("ice restart deferred: signaling down", { peer: short(this.remoteId) });
      return;
    }
    if (reason === "auto" && this.restarts >= this.o.maxRestarts) {
      this.log.warn("ice restarts exhausted", { peer: short(this.remoteId) });
      this.setStatus("failed");
      return;
    }
    this.restarts++;
    this.restartWanted = false;
    const pc = this.pc;
    try {
      pc.setConfiguration({ ...pc.getConfiguration(), iceServers: this.o.iceServers() });
    } catch (e) {
      this.log.warn("setConfiguration failed", errInfo(e));
    }
    this.log.info("ice restart", { peer: short(this.remoteId), attempt: this.restarts, reason });
    if (!this.bound || !pc.remoteDescription) {
      // Nothing negotiated yet: restartIce is meaningless; re-offer if we're the offerer.
      if (this.role === "offerer" && this.bound) void this.makeOffer("ice-restart");
    } else {
      this.sentCandidates = []; // new ufrag: the old candidates are useless
      pc.restartIce();
    }
    this.scheduleCheck();
  }

  private scheduleCheck() {
    this.o.clock.clearTimeout(this.restartTimer);
    this.restartTimer = this.o.clock.setTimeout(() => {
      if (this.closed || this.connected) return;
      if (this.restarts > 0 && this.pc.signalingState === "have-local-offer" && this.o.isSignalingUp()) {
        // Our restart offer was never answered (lost in signaling): more restartIce() calls would only queue
        // behind it. Rebuild the pair instead.
        this.reportStall("no-answer");
        return;
      }
      this.restartIce("auto");
    }, this.o.restartCheckMs * Math.max(1, this.restarts));
  }

  /**
   * The peer said `hello` while this pair is pristine (nothing received from it yet). If we are the offerer and
   * our offer has been outstanding for a while, it was probably lost (or the peer rebuilt after it): re-send the
   * same offer. Idempotent — an answerer that already has it re-sends its answer. A hello arriving right after
   * our offer is the ordinary join-time hello and needs nothing.
   */
  onPeerHello(): void {
    const pc = this.pc;
    if (this.closed || this.role !== "offerer" || pc.signalingState !== "have-local-offer") return;
    if (this.o.clock.now() - this.offerSentAt < this.o.offerResendAfterMs) return;
    this.log.info("hello while our offer is outstanding: re-sending it", { peer: short(this.remoteId) });
    this.resendDescription(pc);
  }

  /** Signaling came back: run any deferred restart / offer. */
  onSignalingRestored(): void {
    if (this.closed) return;
    if (this.offerWanted) {
      this.offerWanted = false;
      void this.makeOffer("deferred");
    }
    if (this.restartWanted && !this.connected) this.restartIce("auto");
  }

  // ── local media & policy ──

  setLocalTrack(kind: "audio" | "video", track: MediaStreamTrack | null): Promise<void> {
    const t = kind === "audio" ? this.audioTx : this.videoTx;
    if (!t || this.closed) return Promise.resolve();
    return t.sender.replaceTrack(track).then(
      () => {
        if (kind === "video") void this.applyEncodings();
      },
      (e) => this.log.warn("replaceTrack failed", { kind, ...errInfo(e) }),
    );
  }

  /** Mode change: new audio bitrate now, fmtp (DTX) via a renegotiation. */
  setMode(_mode: AudioMode): void {
    if (this.closed) return;
    void this.applyEncodings();
    if (this.negotiatedOnce) void this.makeOffer("mode");
  }

  /**
   * Participant count changed (mesh policy input). Crossing a codec tier (ADR-0005) re-applies the codec order and
   * renegotiates — from ONE side only. Both sides of a pair learn of a joiner/leaver at the same moment, so if both
   * re-offered they would always glare: a wasted offer and a rollback on the polite side right after the policy's
   * setParameters, i.e. extra encoder reconfiguration exactly when Firefox's H264 sender is fragile (codecs.ts
   * untrustedPowerEfficient). So, like ICE restarts (FLOWS §6): the impolite side offers; the polite side's new order
   * shapes its answer, and it offers itself only if no remote offer arrived within `politeExtraMs`.
   */
  setParticipants(n: number): void {
    if (n === this.participants) return;
    const tierChanged = codecTier(n) !== codecTier(this.participants);
    this.participants = n;
    void this.applyEncodings();
    if (!tierChanged || !this.bound || this.closed) return;
    this.applyCodecs(); // before the first negotiation the new order simply applies
    if (!this.negotiatedOnce) return;
    if (!this.polite) {
      void this.makeOffer("codec-tier");
      return;
    }
    const offersBefore = this.remoteOffers;
    const tier = codecTier(n);
    this.o.clock.clearTimeout(this.tierTimer);
    this.tierTimer = this.o.clock.setTimeout(() => {
      this.tierTimer = undefined;
      if (this.closed || !this.negotiatedOnce || codecTier(this.participants) !== tier) return;
      if (this.remoteOffers > offersBefore) return; // the impolite side renegotiated: our order went into the answer
      void this.makeOffer("codec-tier-polite");
    }, this.o.politeExtraMs);
  }

  setRemoteView(height: number): void {
    this.remoteView = height;
    void this.applyEncodings();
  }

  get sendLevel(): SendLevel {
    return this._sendLevel;
  }

  /** Video maxBitrate currently applied to our sender (bps); undefined before the first negotiation. */
  get videoMaxBitrate(): number | undefined {
    return this._videoMaxBitrate;
  }

  /** Whether the high send level would change this pair's encode (3–4 tier, receiver wants 360p, sending). */
  get levelEligible(): boolean {
    const v = videoPolicy({
      participants: this.participants,
      viewHeight: this.remoteView,
      sourceShortSide: this.o.local().sourceShortSide,
    });
    return v.active && levelEligible(this.participants, v.targetHeight);
  }

  /** Audio bitrate we send this peer (bps) — part of what the high level needs from the link. */
  get audioBitrate(): number {
    return audioPolicy(this.o.local().mode, this.o.codecPrefs?.audio).maxBitrate;
  }

  /** Adaptive send level (ADR-0008): only the video maxBitrate changes, never the scale. */
  setSendLevel(level: SendLevel): Promise<void> {
    if (level === this._sendLevel) return this.paramsTail;
    this._sendLevel = level;
    return this.applyEncodings();
  }

  /** Read-modify-write sender parameters per policy; serialized (stale transactionIds throw). */
  applyEncodings(): Promise<void> {
    this.paramsTail = this.paramsTail.then(async () => {
      if (this.closed) return;
      const local = this.o.local();
      const v = videoPolicy({
        participants: this.participants,
        viewHeight: this.remoteView,
        sourceShortSide: local.sourceShortSide,
        level: this._sendLevel,
      });
      if (this.degradationUnsupported) delete v.degradationPreference;
      const sender = this.videoTx?.sender;
      await this.setParams(sender, (p) => mergeVideoEncoding(p, v), "video", {
        ...v,
        level: this._sendLevel,
      });
      const applied = sender?.getParameters?.().encodings?.[0]?.maxBitrate;
      if (applied !== undefined) this._videoMaxBitrate = applied;
      const a = audioPolicy(local.mode, this.o.codecPrefs?.audio);
      await this.setParams(this.audioTx?.sender, (p) => mergeAudioEncoding(p, a.maxBitrate), "audio", a);
    });
    return this.paramsTail;
  }

  private async setParams(
    sender: RTCRtpSender | undefined,
    merge: (p: RTCRtpSendParameters) => RTCRtpSendParameters | null,
    kind: string,
    caps: object,
  ) {
    if (!sender || typeof sender.getParameters !== "function") return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) return; // not negotiated yet
      const next = merge(params);
      if (!next) return;
      try {
        await sender.setParameters(next);
      } catch (e) {
        // An engine that rejects degradationPreference: apply the rest without it (bitrate still changes).
        const plain = withoutDegradation(next, params);
        if (JSON.stringify(plain) === JSON.stringify(next)) throw e;
        this.log.warn("degradationPreference rejected; applying without it", {
          peer: short(this.remoteId),
          ...errInfo(e),
        });
        this.degradationUnsupported = true;
        await sender.setParameters(plain);
      }
      this.log.info("policy applied", { peer: short(this.remoteId), kind, ...caps });
    } catch (e) {
      this.log.warn("setParameters failed", { peer: short(this.remoteId), kind, ...errInfo(e) });
    }
  }

  sendCtl(msg: PeerMessage): boolean {
    const ch = this.ctl;
    if (ch?.readyState !== "open") return false;
    try {
      ch.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      this.log.debug("ctl send failed", errInfo(e));
      return false;
    }
  }

  /** Remote audio level 0..1 from RTP header extension (cheap, no getStats). */
  audioLevel(): number {
    const r = this.audioTx?.receiver as
      | (RTCRtpReceiver & { getSynchronizationSources?: () => { audioLevel?: number }[] })
      | undefined;
    if (!r || typeof r.getSynchronizationSources !== "function") return 0;
    try {
      return r.getSynchronizationSources()[0]?.audioLevel ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * `pc.getStats()` that always settles. Firefox never settles a getStats promise that is pending when its pc is
   * closed (Chromium and WebKit resolve it), which would hang every consumer that awaits it: `mesh.stats()` awaits
   * all peers, so one pair closed mid-collect (a peer leaving, a hidden ghost pair dropped, a rebuild) froze
   * `__clearcall.stats()` and stopped the stats sampler for the rest of the call (its busy flag never cleared).
   * Closing or replacing the pc therefore rejects every getStats still pending on it.
   */
  getStats(): Promise<RTCStatsReport> {
    if (this.closed) return Promise.reject(new Error("peer session closed"));
    return new Promise<RTCStatsReport>((resolve, reject) => {
      const abort = (reason: string) => reject(new Error(reason));
      this.pendingStats.add(abort);
      this.pc.getStats().then(
        (r) => {
          this.pendingStats.delete(abort);
          resolve(r);
        },
        (e: unknown) => {
          this.pendingStats.delete(abort);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  /** Rejects the getStats calls pending on the current pc (it is being closed; see `getStats`). */
  private abortPendingStats(reason: string) {
    const pending = [...this.pendingStats];
    this.pendingStats.clear();
    for (const abort of pending) abort(reason);
  }

  /** Transceivers for tests/diagnostics. */
  get transceiverCount(): number {
    return this.pc.getTransceivers().length;
  }

  /** QA fault: kill the transport abruptly (as if the pc died); the owner decides how to recover. */
  kill(): void {
    if (this.closed) return;
    this.log.warn("killed (injected)", { peer: short(this.remoteId) });
    try {
      this.pc.close();
    } catch {}
    this.close();
    this.setStatus("failed");
    this.o.events.dead?.("killed");
  }

  private clearTimers() {
    this.o.clock.clearTimeout(this.restartTimer);
    this.o.clock.clearTimeout(this.connectTimer);
    this.restartTimer = this.connectTimer = undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.o.clock.clearTimeout(this.tierTimer);
    const pc = this.pc;
    pc.onnegotiationneeded = pc.onicecandidate = pc.ontrack = null;
    pc.onconnectionstatechange = pc.onsignalingstatechange = null;
    try {
      this.ctl?.close();
    } catch {}
    try {
      pc.close();
    } catch {}
    this.abortPendingStats("peer session closed");
    this.log.info("closed", { peer: short(this.remoteId) });
  }
}
