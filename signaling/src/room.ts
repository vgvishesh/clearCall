import { DurableObject } from "cloudflare:workers";
import {
  type ClientMessage,
  type ErrorCode,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  type IceServer,
  MAX_MESSAGE_BYTES,
  MAX_PARTICIPANTS,
  PROTOCOL_VERSION,
  parseClientMessage,
  RESUME_GRACE_SECONDS,
  ROOM_ID_RE,
  type ServerMessage,
} from "@clearcall/protocol";
import { CLOSE } from "./close-codes.ts";
import { type Env, ROOM_HEADER } from "./env.ts";
import { type CachedIce, resolveIceServers } from "./ice.ts";
import { TokenBucket } from "./limits.ts";
import { logEvent, short } from "./log.ts";

/** A peer bound to a socket. `seq` orders `welcome.peers` (join order); survives resume. */
interface PeerBinding {
  peerId: string;
  seq: number;
  joinedAt: number;
}

/** Per-socket state, kept in the WebSocket attachment so it survives hibernation. */
interface Attachment {
  connectedAt: number;
  /** Last time we saw a message from this socket (updated at most every SEEN_RESOLUTION_MS). */
  seenAt: number;
  ip?: string;
  peer?: PeerBinding;
  /** Socket no longer represents its peer (left, replaced by resume, closed as dead). Ignore its events. */
  stale?: true;
}

/** A peer whose socket dropped; kept for RESUME_GRACE_SECONDS. Stored in DO storage under `away:<peerId>`. */
interface AwayRecord {
  seq: number;
  joinedAt: number;
  awayUntil: number;
}

const AWAY_PREFIX = "away:";
const K_SEQ = "seq";
const K_ROOM = "room";
const K_ICE = "ice";

const SEEN_RESOLUTION_MS = 10_000;
/** A socket with no heartbeat and no message for this long is treated as dead (FLOWS.md §4). */
/**
 * A socket is "dead" after 4 missed heartbeats. 2× proved too tight: under CPU/thermal load (and on busy phones)
 * pings slip and whole rooms were declared dead at once. Real disconnects are mostly caught by TCP close.
 */
export const DEAD_AFTER_MS = 4 * HEARTBEAT_INTERVAL_MS;

/** One instance per call. Relays opaque signals between peers; never parses `data`. */
export class Room extends DurableObject<Env> {
  /** Sockets currently awaiting their `join` to complete (in-memory; a join never spans hibernation). */
  private readonly joining = new Set<WebSocket>();
  /** Rate-limit state per socket. In memory only: after hibernation (i.e. idle) a full bucket is correct. */
  private readonly buckets = new Map<WebSocket, TokenBucket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("expected websocket", { status: 426 });
    const roomId = request.headers.get(ROOM_HEADER);
    if (roomId && ROOM_ID_RE.test(roomId) && this.ctx.storage.kv.get(K_ROOM) === undefined)
      this.ctx.storage.kv.put(K_ROOM, short(roomId));

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    const ip = request.headers.get("CF-Connecting-IP") ?? undefined;
    server.serializeAttachment({ connectedAt: now, seenAt: now, ...(ip ? { ip } : {}) } satisfies Attachment);
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ───────────────────────────── WebSocket events ─────────────────────────────

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = attachment(ws);
    if (!a || a.stale) return;
    const now = Date.now();
    if (!this.rateOk(ws, a, now)) return;
    if (now - a.seenAt >= SEEN_RESOLUTION_MS) {
      a.seenAt = now;
      ws.serializeAttachment(a);
    }

    if (typeof message !== "string") {
      if (message.byteLength > MAX_MESSAGE_BYTES) return this.error(ws, a, "too-large");
      return this.error(ws, a, "bad-message", "binary frames are not supported");
    }
    if (utf8Length(message) > MAX_MESSAGE_BYTES) return this.error(ws, a, "too-large");
    const m = parseClientMessage(message);
    if (!m) return this.error(ws, a, "bad-message");

    if (!a.peer) {
      if (m.t !== "join") return this.error(ws, a, "not-joined");
      return this.join(ws, m);
    }
    switch (m.t) {
      case "join":
        return this.error(ws, a, "bad-message", "already joined");
      case "signal":
        return this.relay(ws, a.peer, m);
      case "leave":
        return this.leave(ws, a, a.peer);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string): Promise<void> {
    this.joining.delete(ws);
    this.buckets.delete(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
    await this.socketGone(ws);
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.joining.delete(ws);
    this.buckets.delete(ws);
    await this.socketGone(ws);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    // 1. Silently dead sockets → away (they may still resume).
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const a = attachment(ws);
      if (!a || a.stale) continue;
      const pong = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      if (now - Math.max(pong, a.seenAt) <= DEAD_AFTER_MS) continue;
      if (a.peer) this.markAway(a.peer, now);
      this.retire(ws, CLOSE.DEAD, "heartbeat timeout");
      this.log("dead", a.peer?.peerId, CLOSE.DEAD);
    }
    // 2. Away peers whose grace expired → peer-left{timeout}.
    for (const [key, rec] of this.awayRecords()) {
      if (rec.awayUntil > now) continue;
      const peerId = key.slice(AWAY_PREFIX.length);
      this.ctx.storage.kv.delete(key);
      this.broadcast({ t: "peer-left", peerId, reason: "timeout" });
      this.log("timeout", peerId);
    }
    await this.scheduleAlarm(true);
  }

  // ───────────────────────────── Message handlers ─────────────────────────────

  /** Token bucket per socket. Tells the client once per episode; closes on sustained abuse (peer goes away). */
  private rateOk(ws: WebSocket, a: Attachment, now: number): boolean {
    let bucket = this.buckets.get(ws);
    if (!bucket) {
      bucket = new TokenBucket(now);
      this.buckets.set(ws, bucket);
    }
    const verdict = bucket.take(now);
    if (verdict === "ok") return true;
    if (verdict === "limited") this.error(ws, a, "rate-limited");
    if (verdict === "abuse") {
      this.buckets.delete(ws);
      if (a.peer) this.markAway(a.peer, now);
      this.retire(ws, CLOSE.ABUSE, "rate limit abuse");
      this.log("abuse", a.peer?.peerId, CLOSE.ABUSE);
      this.ctx.waitUntil(this.scheduleAlarm());
    }
    return false;
  }

  private async join(ws: WebSocket, m: Extract<ClientMessage, { t: "join" }>): Promise<void> {
    if (m.v !== PROTOCOL_VERSION) {
      this.fatal(ws, "version", CLOSE.VERSION, `server speaks protocol v${PROTOCOL_VERSION}`, m.peerId);
      return;
    }
    if (this.joining.has(ws))
      return this.error(ws, attachment(ws), "bad-message", "join already in progress");
    if (!this.admit(ws, m)) return;

    // Admission looks good: fetch ICE servers (may mint TURN credentials) and then re-check, since other
    // events may have run while we awaited.
    this.joining.add(ws);
    let iceServers: IceServer[];
    try {
      iceServers = await this.iceServers(attachment(ws)?.ip);
    } finally {
      this.joining.delete(ws);
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    const decision = this.admit(ws, m);
    if (!decision) return;

    const a = attachment(ws);
    if (!a) return;
    const now = Date.now();
    if (decision.kind === "resume") {
      if (decision.stale) this.retire(decision.stale, CLOSE.REPLACED, "replaced by resumed socket");
      this.ctx.storage.kv.delete(AWAY_PREFIX + m.peerId);
      a.peer = { peerId: m.peerId, seq: decision.seq, joinedAt: decision.joinedAt };
    } else {
      const seq = (this.ctx.storage.kv.get<number>(K_SEQ) ?? 0) + 1;
      this.ctx.storage.kv.put(K_SEQ, seq);
      a.peer = { peerId: m.peerId, seq, joinedAt: now };
    }
    a.seenAt = now;
    ws.serializeAttachment(a);

    const resumed = decision.kind === "resume";
    this.send(ws, {
      t: "welcome",
      v: PROTOCOL_VERSION,
      peerId: m.peerId,
      peers: this.roster()
        .map((p) => p.peerId)
        .filter((id) => id !== m.peerId),
      iceServers,
      resumed,
    });
    if (!resumed) this.broadcast({ t: "peer-joined", peerId: m.peerId }, m.peerId);
    this.log(resumed ? "resume" : "join", m.peerId);
    await this.scheduleAlarm();
  }

  /**
   * Decide whether `join` may proceed. On rejection, sends the fatal error, closes the socket and returns null.
   * `resume` with an unknown peerId is a fresh join.
   */
  private admit(
    ws: WebSocket,
    m: Extract<ClientMessage, { t: "join" }>,
  ): { kind: "fresh" } | { kind: "resume"; seq: number; joinedAt: number; stale?: WebSocket } | null {
    const bound = this.socketOf(m.peerId, ws);
    const away = this.ctx.storage.kv.get<AwayRecord>(AWAY_PREFIX + m.peerId);
    if (bound || away) {
      if (!m.resume) {
        this.fatal(ws, "duplicate-peer", CLOSE.DUPLICATE_PEER, "peerId already in this room", m.peerId);
        return null;
      }
      const binding = bound ? bound.peer : away!;
      return {
        kind: "resume",
        seq: binding.seq,
        joinedAt: binding.joinedAt,
        ...(bound ? { stale: bound.ws } : {}),
      };
    }
    if (this.roster().length >= MAX_PARTICIPANTS) {
      this.fatal(ws, "room-full", CLOSE.ROOM_FULL, `room is limited to ${MAX_PARTICIPANTS} peers`, m.peerId);
      return null;
    }
    return { kind: "fresh" };
  }

  private relay(ws: WebSocket, from: PeerBinding, m: Extract<ClientMessage, { t: "signal" }>): void {
    const target = m.to === from.peerId ? undefined : this.socketOf(m.to);
    if (!target) {
      this.send(ws, { t: "error", code: "unknown-peer", peerId: m.to });
      this.log("unknown-peer", from.peerId, "unknown-peer");
      return;
    }
    // `data` is forwarded verbatim: never parsed, never logged.
    const out = JSON.stringify({ t: "signal", from: from.peerId, data: m.data } satisfies ServerMessage);
    // `from` is 2 bytes longer than `to`: refuse what receivers would reject as oversized.
    if (out.length > MAX_MESSAGE_BYTES) {
      this.error(ws, attachment(ws), "too-large");
      return;
    }
    try {
      target.ws.send(out);
    } catch {
      // target went away; its close event handles presence
    }
  }

  private async leave(ws: WebSocket, a: Attachment, peer: PeerBinding): Promise<void> {
    a.stale = true;
    ws.serializeAttachment(a);
    try {
      ws.close(CLOSE.LEFT, "left");
    } catch {
      // already closing
    }
    this.broadcast({ t: "peer-left", peerId: peer.peerId, reason: "left" });
    this.log("leave", peer.peerId);
    await this.scheduleAlarm();
  }

  // ───────────────────────────── Presence ─────────────────────────────

  /** A socket closed or errored without `leave`: its peer becomes away unless another socket now owns it. */
  private async socketGone(ws: WebSocket): Promise<void> {
    const a = attachment(ws);
    if (!a?.peer || a.stale) return;
    if (this.socketOf(a.peer.peerId, ws)) return; // rebound by a resume; ignore the old socket's close
    try {
      a.stale = true;
      ws.serializeAttachment(a);
    } catch {
      // closed sockets may refuse attachment writes; `readyState` filtering covers us
    }
    this.markAway(a.peer, Date.now());
    this.log("away", a.peer.peerId);
    await this.scheduleAlarm();
  }

  private markAway(peer: PeerBinding, now: number): void {
    this.ctx.storage.kv.put(AWAY_PREFIX + peer.peerId, {
      seq: peer.seq,
      joinedAt: peer.joinedAt,
      awayUntil: now + RESUME_GRACE_SECONDS * 1000,
    } satisfies AwayRecord);
  }

  /** Mark a socket as no longer representing its peer and close it. No presence change. */
  private retire(ws: WebSocket, code: number, reason: string): void {
    this.buckets.delete(ws);
    const a = attachment(ws);
    if (a) {
      a.stale = true;
      try {
        ws.serializeAttachment(a);
      } catch {
        // ignore
      }
    }
    try {
      ws.close(code, reason);
    } catch {
      // ignore
    }
  }

  /** Materialized: only one kv.list() iterator may exist at a time. */
  private awayRecords(): [string, AwayRecord][] {
    return Array.from(this.ctx.storage.kv.list<AwayRecord>({ prefix: AWAY_PREFIX }));
  }

  /** Open, joined, non-stale sockets. */
  private active(): { ws: WebSocket; peer: PeerBinding }[] {
    const out: { ws: WebSocket; peer: PeerBinding }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const a = attachment(ws);
      if (a?.peer && !a.stale) out.push({ ws, peer: a.peer });
    }
    return out;
  }

  private socketOf(peerId: string, except?: WebSocket): { ws: WebSocket; peer: PeerBinding } | undefined {
    return this.active().find((s) => s.peer.peerId === peerId && s.ws !== except);
  }

  /** Everyone counted toward capacity (active + away), in join order. */
  private roster(): { peerId: string; seq: number }[] {
    const list = this.active().map((s) => ({ peerId: s.peer.peerId, seq: s.peer.seq }));
    for (const [key, rec] of this.awayRecords())
      list.push({ peerId: key.slice(AWAY_PREFIX.length), seq: rec.seq });
    return list.sort((x, y) => x.seq - y.seq);
  }

  // ───────────────────────────── Alarm scheduling ─────────────────────────────

  /**
   * Next alarm = earliest away expiry, and a dead-socket check every DEAD_AFTER_MS while sockets are open.
   * An earlier pending alarm is kept (it reschedules itself). With nobody left at all, wipe the room's storage.
   */
  private async scheduleAlarm(fromAlarm = false): Promise<void> {
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const [, rec] of this.awayRecords()) next = Math.min(next, rec.awayUntil);
    const open = this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.OPEN && !attachment(ws)?.stale);
    if (open.length > 0) next = Math.min(next, now + DEAD_AFTER_MS);
    if (Number.isFinite(next)) {
      const current = fromAlarm ? null : await this.ctx.storage.getAlarm();
      if (current === null || current > next) await this.ctx.storage.setAlarm(next);
      return;
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ───────────────────────────── ICE ─────────────────────────────

  private async iceServers(ip: string | undefined): Promise<IceServer[]> {
    const { iceServers, outcome } = await resolveIceServers(
      {
        keyId: this.env.TURN_KEY_ID,
        apiToken: this.env.TURN_KEY_API_TOKEN,
        limiter: this.env.TURN_MINT_LIMITER,
        cache: {
          get: () => this.ctx.storage.kv.get<CachedIce>(K_ICE),
          put: (v) => this.ctx.storage.kv.put(K_ICE, v),
        },
        now: Date.now(),
      },
      ip,
    );
    if (outcome !== "stun-only" && outcome !== "cached") this.log(`turn-${outcome}`);
    return iceServers;
  }

  // ───────────────────────────── Output ─────────────────────────────

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket went away; its close event handles presence
    }
  }

  private broadcast(msg: ServerMessage, exceptPeerId?: string): void {
    for (const s of this.active()) if (s.peer.peerId !== exceptPeerId) this.send(s.ws, msg);
  }

  private error(ws: WebSocket, a: Attachment | undefined, code: ErrorCode, message?: string): void {
    this.send(ws, { t: "error", code, ...(message ? { message } : {}) });
    this.log(code, a?.peer?.peerId, code);
  }

  private fatal(ws: WebSocket, code: ErrorCode, closeCode: number, message: string, peerId: string): void {
    this.send(ws, { t: "error", code, message });
    this.retire(ws, closeCode, code);
    this.log(code, peerId, closeCode);
  }

  private log(evt: string, peerId?: string, code?: string | number): void {
    logEvent({
      evt,
      room: this.ctx.storage.kv.get<string>(K_ROOM) ?? "",
      ...(peerId ? { peer: short(peerId) } : {}),
      n: this.roster().length,
      ...(code !== undefined ? { code } : {}),
    });
  }
}

function attachment(ws: WebSocket): Attachment | undefined {
  return (ws.deserializeAttachment() as Attachment | null) ?? undefined;
}

/** UTF-8 byte length, computed only when it could exceed the limit (≤ 3 bytes per UTF-16 unit). */
function utf8Length(s: string): number {
  if (s.length * 3 <= MAX_MESSAGE_BYTES) return s.length;
  return new TextEncoder().encode(s).byteLength;
}
