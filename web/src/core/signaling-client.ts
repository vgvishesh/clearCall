/**
 * Signaling client (FLOWS.md §1, §4, §7): one WebSocket to `/api/room/<roomId>`, join/resume, heartbeat,
 * reconnect with jittered backoff, end-to-end encrypted peer payloads.
 *
 * - Every `signal` payload is AES-GCM encrypted (protocol/crypto.ts); undecryptable blobs are dropped.
 * - Inbound payloads are emitted in arrival order per sender even though decryption is async.
 * - Outbound payloads keep call order (encryption is chained) and never overtake the outbox. While the socket is
 *   down they wait in the outbox; `discardQueued(to)` drops a peer's entries when its pair was rebuilt. The outbox is
 *   flushed after `welcome{resumed:true}` and discarded after `welcome{resumed:false}` (pairs get rebuilt).
 * - Before the first welcome: gives up after `firstJoinGiveUpMs` (20 s) → fatal "unavailable".
 * - Once joined: keeps reconnecting (backoff capped at `rejoinBackoffMaxMs`, ~30 s) for as long as the call is alive
 *   (`isCallAlive()`: some P2P pair still connected — media flows without signaling). Gives up only after `giveUpMs`
 *   (60 s) during which signaling was down *and* no pair was connected.
 */
import {
  decryptSignal,
  type ErrorCode,
  encryptSignal,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  type IceServer,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseServerMessage,
  type RoomKeys,
  type SignalPayload,
} from "@clearcall/protocol";
import type { Clock, TimerHandle } from "./clock.ts";
import { errInfo, type Logger, nullLogger, short } from "./log.ts";

export interface SignalCipher {
  encrypt(from: string, to: string, payload: SignalPayload): Promise<string>;
  decrypt(from: string, to: string, blob: string): Promise<SignalPayload | null>;
}

export function roomCipher(keys: RoomKeys): SignalCipher {
  return {
    encrypt: (from, to, payload) => encryptSignal(keys, from, to, payload),
    decrypt: (from, to, blob) => decryptSignal(keys, from, to, blob),
  };
}

/** Minimal WebSocket surface we use (real WebSocket satisfies it). */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

const WS_OPEN = 1;

export type SignalingStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";
export type FatalSignalingCode = "room-full" | "version" | "duplicate-peer" | "unavailable" | "replaced";

export interface WelcomeInfo {
  peers: string[];
  iceServers: IceServer[];
  resumed: boolean;
}

export interface SignalingHandlers {
  status?(status: SignalingStatus): void;
  welcome?(info: WelcomeInfo): void;
  peerJoined?(peerId: string): void;
  peerLeft?(peerId: string, reason: "left" | "timeout"): void;
  signal?(from: string, payload: SignalPayload): void;
  /** Non-fatal server errors (unknown-peer carries the peerId). */
  error?(code: ErrorCode, peerId?: string): void;
  fatal?(code: FatalSignalingCode, detail?: string): void;
}

export interface SignalingOptions {
  url: string;
  peerId: string;
  cipher: SignalCipher;
  WebSocket: WebSocketCtor;
  clock: Clock;
  random?: () => number;
  log?: Logger;
  handlers: SignalingHandlers;
  backoffInitialMs?: number;
  /** Backoff cap before the first welcome. */
  backoffMaxMs?: number;
  /** Backoff cap once we have been in the room (long outages while P2P media keeps flowing). */
  rejoinBackoffMaxMs?: number;
  /** Once joined: give up after signaling has been down this long with no connected pair. */
  giveUpMs?: number;
  /** True while the call is still alive without signaling (a P2P pair is connected). Default: never. */
  isCallAlive?: () => boolean;
  /** How often `isCallAlive` is sampled while disconnected. */
  aliveCheckMs?: number;
  /** Give up on the very first join after this long. */
  firstJoinGiveUpMs?: number;
  heartbeatMs?: number;
  /** No message for this long (with ≥ 2 pings unanswered) ⇒ socket dead. Default HEARTBEAT_DEAD_AFTER_MS. */
  deadAfterMs?: number;
  /** A socket that hasn't opened after this long is abandoned and retried. */
  connectTimeoutMs?: number;
  outboxLimit?: number;
}

const FATAL: readonly ErrorCode[] = ["room-full", "version", "duplicate-peer"];

/**
 * WebSocket close codes used by the signaling Worker (package A). To move into @clearcall/protocol at integration.
 * Anything not listed here (incl. 1006) → reconnect with `join{resume:true}`.
 */
export const CLOSE = {
  /** After our own `leave`. */
  NORMAL: 1000,
  ROOM_FULL: 4001,
  VERSION: 4002,
  DUPLICATE_PEER: 4003,
  /** Our peerId was taken over by a newer socket that resumed it. Do NOT reconnect. */
  REPLACED: 4004,
  /** Rate-limit abuse: marked away server-side; resume. */
  RATE_LIMITED: 4005,
  /** No message/heartbeat for > 4 × HEARTBEAT_INTERVAL_MS (60 s): marked away; resume. */
  IDLE: 4006,
} as const;

/**
 * Client cutoff for a silently dead socket: no message (pong or anything else) for this long, with at least two
 * pings unanswered in that time → close and resume.
 *
 * Rationale — 3 × HEARTBEAT_INTERVAL_MS (45 s):
 * - It tolerates two consecutive lost/late pongs (GC pause, saturated main thread or uplink, a mobile radio waking
 *   up) and only the third miss counts; the old 2 × interval + 5 s (35 s) dropped a live socket after two misses.
 * - It stays below the server's 4 × interval (60 s, `DEAD_AFTER_MS` in signaling/), so in the common case of a
 *   half-open socket we resume (`join{resume}`) before the server marks us away: peers see no presence change.
 * - The unanswered-ping condition means a tab whose timers were frozen/throttled (background, laptop sleep) is
 *   not declared dead on wake-up just because it did not ask; it pings first.
 * A false positive only costs a resume (pairs survive); detection takes 45–50 s (checked every HEARTBEAT_CHECK_MS).
 */
export const HEARTBEAT_DEAD_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS;
/** How often liveness is evaluated (pings still go out every HEARTBEAT_INTERVAL_MS). */
const HEARTBEAT_CHECK_MS = 5_000;

/** Client-internal close reasons (never sent by the server). */
const LOCAL_CLOSE = { CONNECT_TIMEOUT: 4900, HEARTBEAT_LOST: 4901, INJECTED: 4999 } as const;

/** The Worker relays `{t:"signal",from,data}` which is 2 bytes longer than what we send. */
export const MAX_SIGNAL_BYTES = MAX_MESSAGE_BYTES - 2;

export function roomUrl(location: { protocol: string; host: string }, roomId: string): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/api/room/${roomId}`;
}

/** Jittered exponential backoff: attempt 0 → 0.25–0.5 s … capped at 4–8 s. */
export function backoffDelay(attempt: number, random: () => number, initialMs = 500, maxMs = 8000): number {
  const base = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt));
  return Math.round(base / 2 + (random() * base) / 2);
}

export class SignalingClient {
  private ws: WebSocketLike | null = null;
  private _status: SignalingStatus = "idle";
  private joined = false;
  private everJoined = false;
  /** A join has been sent at least once: any later join must be a resume (else the server says duplicate-peer). */
  private joinSent = false;
  private stopped = false;
  private attempt = 0;
  private disconnectedSince: number | null = null;
  private reconnectTimer: TimerHandle | undefined;
  private giveUpTimer: TimerHandle | undefined;
  /** Interval sampling `isCallAlive` while disconnected after having joined. */
  private aliveTimer: TimerHandle | undefined;
  private lastAliveAt = 0;
  private aliveNoted = false;
  private connectTimer: TimerHandle | undefined;
  private heartbeatTimer: TimerHandle | undefined;
  private lastRx = 0;
  private lastPingAt = 0;
  /** Pings sent since the last message received on the current socket. */
  private pingsUnanswered = 0;
  private sendTail: Promise<void> = Promise.resolve();
  private decryptTails = new Map<string, Promise<void>>();
  private outbox: { to: string; raw: string }[] = [];
  private readonly o: Required<Omit<SignalingOptions, "log" | "random" | "isCallAlive">> & {
    log: Logger;
    random: () => number;
    isCallAlive: () => boolean;
  };

  constructor(opts: SignalingOptions) {
    this.o = {
      backoffInitialMs: 500,
      backoffMaxMs: 8000,
      rejoinBackoffMaxMs: 30_000,
      giveUpMs: 60_000,
      isCallAlive: () => false,
      aliveCheckMs: 1000,
      firstJoinGiveUpMs: 20_000,
      heartbeatMs: HEARTBEAT_INTERVAL_MS,
      deadAfterMs: HEARTBEAT_DEAD_AFTER_MS,
      connectTimeoutMs: 10_000,
      outboxLimit: 500,
      random: Math.random,
      log: nullLogger,
      ...opts,
    } as SignalingClient["o"];
  }

  get status(): SignalingStatus {
    return this._status;
  }

  get isJoined(): boolean {
    return this.joined;
  }

  get peerId(): string {
    return this.o.peerId;
  }

  connect(): void {
    if (this.stopped || this.ws) return;
    this.open();
  }

  /** Encrypt and relay a payload to one peer. Order of calls is preserved. */
  send(to: string, payload: SignalPayload): void {
    if (this.stopped) return;
    this.sendTail = this.sendTail.then(async () => {
      try {
        const data = await this.o.cipher.encrypt(this.o.peerId, to, payload);
        const raw = JSON.stringify({ t: "signal", to, data });
        if (raw.length > MAX_SIGNAL_BYTES) {
          this.o.log.error("signal too large, dropped", {
            to: short(to),
            kind: payload.k,
            bytes: raw.length,
          });
          return;
        }
        this.sendRaw(to, raw);
      } catch (e) {
        this.o.log.error("encrypt failed", { to: short(to), ...errInfo(e) });
      }
    });
  }

  /** Graceful leave: `leave` if the socket is up, then close for good. */
  leave(): void {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState === WS_OPEN && this.joined) {
      try {
        this.ws.send(JSON.stringify({ t: "leave" }));
      } catch {}
    }
    this.shutdown("closed");
  }

  /** Close without leaving (peer will time out server-side). */
  close(): void {
    this.shutdown("closed");
  }

  /** Simulate a network drop (QA `inject("drop-signaling")`): the socket dies, reconnect logic takes over. */
  drop(): void {
    if (!this.ws) return;
    this.o.log.warn("dropping socket (injected)");
    this.handleClose(this.ws, { code: LOCAL_CLOSE.INJECTED, reason: "injected" });
  }

  /** Reconnect now if we are waiting in backoff (e.g. the browser fired `online`). */
  nudge(): void {
    if (this.stopped || this.ws || this.reconnectTimer === undefined) return;
    this.o.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.open();
  }

  /**
   * Drop everything sent to `to` so far that is still waiting in the outbox (its pair was rebuilt: stale sdp/ice
   * would confuse the peer's fresh pair). Ordered with `send`: later sends are kept.
   */
  discardQueued(to: string): void {
    if (this.stopped) return;
    this.sendTail = this.sendTail.then(() => {
      const before = this.outbox.length;
      this.outbox = this.outbox.filter((e) => e.to !== to);
      const n = before - this.outbox.length;
      if (n) this.o.log.info("stale outbox entries dropped", { to: short(to), n });
    });
  }

  /** Resolves once queued outbound encryptions have been handed to the socket/outbox. */
  flush(): Promise<void> {
    return this.sendTail;
  }

  // ── internals ──

  private setStatus(s: SignalingStatus) {
    if (this._status === s) return;
    this._status = s;
    this.o.log.info("status", { status: s });
    this.o.handlers.status?.(s);
  }

  private open() {
    const { clock, log } = this.o;
    this.setStatus(this.everJoined ? "reconnecting" : "connecting");
    log.info("connecting", { attempt: this.attempt, resume: this.everJoined });
    let ws: WebSocketLike;
    try {
      ws = new this.o.WebSocket(this.o.url);
    } catch (e) {
      log.error("websocket ctor failed", errInfo(e));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connectTimer = clock.setTimeout(() => {
      if (this.ws === ws && ws.readyState !== WS_OPEN) {
        log.warn("connect timeout");
        this.handleClose(ws, { code: LOCAL_CLOSE.CONNECT_TIMEOUT, reason: "connect-timeout" });
      }
    }, this.o.connectTimeoutMs);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      clock.clearTimeout(this.connectTimer);
      this.lastRx = clock.now();
      const join = {
        t: "join",
        v: PROTOCOL_VERSION,
        peerId: this.o.peerId,
        ...(this.joinSent ? { resume: true } : {}),
      };
      ws.send(JSON.stringify(join));
      this.joinSent = true;
      this.startHeartbeat(ws);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastRx = clock.now();
      this.pingsUnanswered = 0;
      this.onMessage(ev.data);
    };
    ws.onclose = (ev) => this.handleClose(ws, ev);
    ws.onerror = () => {
      log.debug("socket error");
    };
  }

  private startHeartbeat(ws: WebSocketLike) {
    const { clock } = this.o;
    clock.clearInterval(this.heartbeatTimer);
    this.pingsUnanswered = 0;
    this.lastPingAt = clock.now();
    const checkMs = Math.min(HEARTBEAT_CHECK_MS, this.o.heartbeatMs);
    this.heartbeatTimer = clock.setInterval(() => {
      if (this.ws !== ws) return;
      const now = clock.now();
      if (now - this.lastRx > this.o.deadAfterMs && this.pingsUnanswered >= 2) {
        this.o.log.warn("heartbeat lost", { silentMs: now - this.lastRx, unanswered: this.pingsUnanswered });
        this.handleClose(ws, { code: LOCAL_CLOSE.HEARTBEAT_LOST, reason: "heartbeat" });
        return;
      }
      if (now - this.lastPingAt < this.o.heartbeatMs) return;
      this.lastPingAt = now;
      this.pingsUnanswered++;
      try {
        ws.send(HEARTBEAT_REQUEST);
      } catch {}
    }, checkMs);
  }

  private onMessage(data: unknown) {
    if (data === HEARTBEAT_RESPONSE) return;
    const msg = parseServerMessage(data);
    if (!msg) {
      this.o.log.debug("ignored unknown server message");
      return;
    }
    switch (msg.t) {
      case "welcome":
        this.onWelcome(msg);
        return;
      case "peer-joined":
        this.o.log.info("peer-joined", { peer: short(msg.peerId) });
        this.o.handlers.peerJoined?.(msg.peerId);
        return;
      case "peer-left":
        this.o.log.info("peer-left", { peer: short(msg.peerId), reason: msg.reason });
        this.o.handlers.peerLeft?.(msg.peerId, msg.reason);
        return;
      case "signal":
        this.onSignal(msg.from, msg.data);
        return;
      case "error":
        if (FATAL.includes(msg.code)) {
          this.o.log.error("fatal server error", { code: msg.code });
          this.fail(msg.code as FatalSignalingCode, msg.message);
        } else {
          this.o.log.warn("server error", {
            code: msg.code,
            ...(msg.peerId ? { peer: short(msg.peerId) } : {}),
          });
          this.o.handlers.error?.(msg.code, msg.peerId);
        }
        return;
    }
  }

  private onWelcome(msg: {
    v: number;
    peerId: string;
    peers: string[];
    iceServers: IceServer[];
    resumed: boolean;
  }) {
    if (msg.v !== PROTOCOL_VERSION) {
      this.fail("version", `server v${msg.v}`);
      return;
    }
    const wasResume = this.everJoined;
    this.joined = true;
    this.everJoined = true;
    this.attempt = 0;
    this.disconnectedSince = null;
    this.o.clock.clearTimeout(this.giveUpTimer);
    this.o.clock.clearInterval(this.aliveTimer);
    this.giveUpTimer = this.aliveTimer = undefined;
    this.o.log.info("welcome", { peers: msg.peers.length, resumed: msg.resumed, wasResume });
    if (!msg.resumed && this.outbox.length) {
      this.o.log.info("outbox discarded", { n: this.outbox.length });
      this.outbox = [];
    }
    this.setStatus("open");
    // The handler may rebuild pairs (discardQueued + hello); both are chained on sendTail, so the flush is too:
    // stale entries are dropped first and new sends queue behind the older ones still in the outbox.
    this.o.handlers.welcome?.({ peers: msg.peers, iceServers: msg.iceServers, resumed: msg.resumed });
    this.sendTail = this.sendTail.then(() => this.flushOutbox());
  }

  private flushOutbox() {
    const pending = this.outbox;
    this.outbox = [];
    for (const e of pending) this.sendRaw(e.to, e.raw);
  }

  private onSignal(from: string, blob: string) {
    const prev = this.decryptTails.get(from) ?? Promise.resolve();
    const decrypting = this.o.cipher.decrypt(from, this.o.peerId, blob);
    const next = prev.then(async () => {
      const payload = await decrypting;
      if (this.stopped) return;
      if (!payload) {
        this.o.log.warn("undecryptable signal dropped", { from: short(from) });
        return;
      }
      this.o.handlers.signal?.(from, payload);
    });
    const tail = next.catch(() => {});
    this.decryptTails.set(from, tail);
    void tail.then(() => {
      if (this.decryptTails.get(from) === tail) this.decryptTails.delete(from);
    });
  }

  private sendRaw(to: string, raw: string) {
    // Never overtake older queued messages (they're flushed in order right after a resumed welcome).
    if (this.ws && this.ws.readyState === WS_OPEN && this.joined && this.outbox.length === 0) {
      try {
        this.ws.send(raw);
        return;
      } catch (e) {
        this.o.log.warn("send failed", errInfo(e));
      }
    }
    if (this.outbox.length >= this.o.outboxLimit) this.outbox.shift();
    this.outbox.push({ to, raw });
  }

  private handleClose(ws: WebSocketLike, ev: { code?: number; reason?: string }) {
    if (this.ws !== ws) return;
    const { clock, log } = this.o;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {}
    clock.clearTimeout(this.connectTimer);
    clock.clearInterval(this.heartbeatTimer);
    this.joined = false;
    if (this.stopped) return;
    const code = ev.code ?? 0;
    log.warn("socket closed", { code });
    const fatalByCode: Partial<Record<number, FatalSignalingCode>> = {
      [CLOSE.ROOM_FULL]: "room-full",
      [CLOSE.VERSION]: "version",
      [CLOSE.DUPLICATE_PEER]: "duplicate-peer",
      [CLOSE.REPLACED]: "replaced",
    };
    const fatal = fatalByCode[code];
    if (fatal) {
      // Normally preceded by an error message; the close code alone is enough.
      this.fail(fatal, `close ${code}`);
      return;
    }
    if (this.disconnectedSince === null) {
      this.disconnectedSince = clock.now();
      if (this.everJoined) this.watchCallAlive();
      else {
        const limit = this.o.firstJoinGiveUpMs;
        clock.clearTimeout(this.giveUpTimer);
        this.giveUpTimer = clock.setTimeout(() => {
          if (!this.joined && !this.stopped) {
            log.error("giving up", { afterMs: limit });
            this.fail("unavailable", `no welcome for ${limit} ms`);
          }
        }, limit);
      }
    }
    this.setStatus(this.everJoined ? "reconnecting" : "connecting");
    this.scheduleReconnect();
  }

  /**
   * Disconnected after having joined: give up only once signaling has been down for `giveUpMs` with no connected
   * P2P pair during that time (a call whose media still flows must not end because the relay is unreachable).
   */
  private watchCallAlive() {
    const { clock, log } = this.o;
    this.lastAliveAt = clock.now();
    this.aliveNoted = false;
    clock.clearInterval(this.aliveTimer);
    const check = () => {
      if (this.joined || this.stopped) {
        clock.clearInterval(this.aliveTimer);
        this.aliveTimer = undefined;
        return;
      }
      const now = clock.now();
      let alive = false;
      try {
        alive = this.o.isCallAlive();
      } catch {}
      if (alive) {
        this.lastAliveAt = now;
        if (!this.aliveNoted && now - (this.disconnectedSince ?? now) >= this.o.giveUpMs) {
          this.aliveNoted = true;
          log.warn("signaling still down, call alive: keep reconnecting", {
            downMs: now - (this.disconnectedSince ?? now),
          });
        }
        return;
      }
      const deadFor = now - this.lastAliveAt;
      if (deadFor >= this.o.giveUpMs) {
        log.error("giving up", { afterMs: now - (this.disconnectedSince ?? now), noPairForMs: deadFor });
        this.fail("unavailable", `no signaling and no connected pair for ${deadFor} ms`);
      }
    };
    this.aliveTimer = clock.setInterval(check, this.o.aliveCheckMs);
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const cap = this.everJoined ? this.o.rejoinBackoffMaxMs : this.o.backoffMaxMs;
    const delay = backoffDelay(this.attempt++, this.o.random, this.o.backoffInitialMs, cap);
    this.o.log.info("reconnect scheduled", { delayMs: delay, attempt: this.attempt });
    this.reconnectTimer = this.o.clock.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
  }

  private fail(code: FatalSignalingCode, detail?: string) {
    this.shutdown("closed");
    this.o.handlers.fatal?.(code, detail);
  }

  private shutdown(status: SignalingStatus) {
    if (this.stopped) return;
    this.stopped = true;
    const { clock } = this.o;
    clock.clearTimeout(this.reconnectTimer);
    clock.clearTimeout(this.giveUpTimer);
    clock.clearTimeout(this.connectTimer);
    clock.clearInterval(this.heartbeatTimer);
    clock.clearInterval(this.aliveTimer);
    this.reconnectTimer =
      this.giveUpTimer =
      this.connectTimer =
      this.heartbeatTimer =
      this.aliveTimer =
        undefined;
    const ws = this.ws;
    this.ws = null;
    this.joined = false;
    this.outbox = [];
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000, "bye");
      } catch {}
    }
    this.setStatus(status);
  }
}
