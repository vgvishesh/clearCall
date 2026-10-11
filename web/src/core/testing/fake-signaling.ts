/**
 * In-memory signaling server implementing the protocol v1 server side (FLOWS.md) + a WebSocket fake bound to it.
 * Test-only. Delivery is asynchronous (microtasks) like a real network; grace timeouts use the injected Clock.
 */
import {
  type ClientMessage,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  type IceServer,
  MAX_PARTICIPANTS,
  PROTOCOL_VERSION,
  parseClientMessage,
  RESUME_GRACE_SECONDS,
  type ServerMessage,
} from "@clearcall/protocol";
import type { Clock, TimerHandle } from "../clock.ts";
import type { WebSocketCtor, WebSocketLike } from "../signaling-client.ts";

interface PeerEntry {
  peerId: string;
  socket: FakeServerSocket | null;
  awayTimer?: TimerHandle;
}

type ClientSide = WebSocketLike & { deliver(data: string): void; serverClosed(code: number): void };

export class FakeServerSocket {
  peerId: string | null = null;
  closed = false;
  constructor(
    readonly server: FakeSignalingServer,
    readonly client: ClientSide,
    readonly url: string,
  ) {}
  send(msg: ServerMessage | string) {
    if (this.closed) return;
    const data = typeof msg === "string" ? msg : JSON.stringify(msg);
    this.server.sent.push({ to: this.peerId, msg: typeof msg === "string" ? msg : msg });
    queueMicrotask(() => this.client.deliver(data));
  }
  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.client.serverClosed(code));
  }
}

export interface FakeServerOptions {
  iceServers?: IceServer[];
  capacity?: number;
  graceMs?: number;
  version?: number;
}

export class FakeSignalingServer {
  readonly peers = new Map<string, PeerEntry>();
  readonly sockets = new Set<FakeServerSocket>();
  readonly sent: { to: string | null; msg: ServerMessage | string }[] = [];
  readonly received: { from: string | null; msg: ClientMessage | string }[] = [];
  /** When true, new connections fail (socket closes without opening). */
  refuse = false;
  /** When true, new connections never open nor close (hang). */
  hang = false;
  /** When false, heartbeat pings are not answered. */
  answerPings = true;
  /** Relay filter: return false to silently lose a signal (models messages lost in flight). */
  relayFilter: ((from: string, to: string) => boolean) | null = null;
  /** Signals lost by `relayFilter`. */
  lost = 0;
  readonly WebSocket: WebSocketCtor;
  private readonly iceServers: IceServer[];
  private readonly capacity: number;
  private readonly graceMs: number;
  private readonly version: number;

  constructor(
    private readonly clock: Clock,
    opts: FakeServerOptions = {},
  ) {
    this.iceServers = opts.iceServers ?? [{ urls: "stun:stun.example.test:3478" }];
    this.capacity = opts.capacity ?? MAX_PARTICIPANTS;
    this.graceMs = opts.graceMs ?? RESUME_GRACE_SECONDS * 1000;
    this.version = opts.version ?? PROTOCOL_VERSION;
    const server = this;
    this.WebSocket = class FakeWebSocket implements WebSocketLike {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = 0;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      private socket: FakeServerSocket | null = null;
      constructor(readonly url: string) {
        server.connections++;
        if (server.hang) return;
        queueMicrotask(() => {
          if (this.readyState !== 0) return;
          if (server.refuse) {
            this.readyState = 3;
            this.onerror?.({});
            this.onclose?.({ code: 1006 });
            return;
          }
          this.socket = server.accept(this as unknown as ClientSide, url);
          this.readyState = 1;
          this.onopen?.({});
        });
      }
      send(data: string) {
        if (this.readyState !== 1) throw new Error("InvalidStateError: not open");
        const s = this.socket;
        queueMicrotask(() => s && server.receive(s, data));
      }
      close(code = 1000) {
        if (this.readyState === 3) return;
        const wasOpen = this.readyState === 1;
        this.readyState = 3;
        const s = this.socket;
        if (s && wasOpen) queueMicrotask(() => server.socketClosed(s));
        queueMicrotask(() => this.onclose?.({ code }));
      }
      deliver(data: string) {
        if (this.readyState === 1) this.onmessage?.({ data });
      }
      serverClosed(code: number) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose?.({ code });
      }
    } as unknown as WebSocketCtor;
  }

  connections = 0;

  accept(client: ClientSide, url: string): FakeServerSocket {
    const s = new FakeServerSocket(this, client, url);
    this.sockets.add(s);
    return s;
  }

  /** Active (non-away) peer ids. */
  activePeers(): string[] {
    return [...this.peers.values()].filter((p) => p.socket).map((p) => p.peerId);
  }

  /** Simulate a network drop of one peer's socket (server sees close, client sees abnormal close). */
  dropPeer(peerId: string, code = 1006): void {
    const p = this.peers.get(peerId);
    const s = p?.socket;
    if (!s) return;
    s.close(code);
    this.socketClosed(s);
  }

  receive(s: FakeServerSocket, raw: string): void {
    if (s.closed) return;
    if (raw === HEARTBEAT_REQUEST) {
      this.received.push({ from: s.peerId, msg: raw });
      if (this.answerPings) s.send(HEARTBEAT_RESPONSE);
      return;
    }
    const msg = parseClientMessage(raw);
    if (!msg) {
      s.send({ t: "error", code: "bad-message" });
      return;
    }
    this.received.push({ from: s.peerId, msg });
    if (msg.t !== "join" && !s.peerId) {
      s.send({ t: "error", code: "not-joined" });
      return;
    }
    switch (msg.t) {
      case "join":
        this.join(s, msg);
        return;
      case "signal": {
        const target = this.peers.get(msg.to);
        if (!target?.socket) {
          s.send({ t: "error", code: "unknown-peer", peerId: msg.to });
          return;
        }
        if (this.relayFilter && !this.relayFilter(s.peerId!, msg.to)) {
          this.lost++;
          return;
        }
        target.socket.send({ t: "signal", from: s.peerId!, data: msg.data });
        return;
      }
      case "leave": {
        const id = s.peerId!;
        this.remove(id);
        this.broadcast({ t: "peer-left", peerId: id, reason: "left" }, id);
        s.close();
        return;
      }
    }
  }

  private join(s: FakeServerSocket, msg: { v: number; peerId: string; resume?: boolean }) {
    if (msg.v !== this.version) {
      s.send({ t: "error", code: "version" });
      s.close(4002);
      return;
    }
    const existing = this.peers.get(msg.peerId);
    if (existing && msg.resume) {
      const stale = existing.socket;
      if (stale && stale !== s) {
        stale.peerId = null;
        stale.close(4004);
      }
      this.clock.clearTimeout(existing.awayTimer);
      existing.awayTimer = undefined;
      existing.socket = s;
      s.peerId = msg.peerId;
      s.send(this.welcome(msg.peerId, true));
      return;
    }
    if (existing) {
      s.send({ t: "error", code: "duplicate-peer" });
      s.close(4003);
      return;
    }
    if (this.peers.size >= this.capacity) {
      s.send({ t: "error", code: "room-full" });
      s.close(4001);
      return;
    }
    this.peers.set(msg.peerId, { peerId: msg.peerId, socket: s });
    s.peerId = msg.peerId;
    s.send(this.welcome(msg.peerId, false));
    this.broadcast({ t: "peer-joined", peerId: msg.peerId }, msg.peerId);
  }

  private welcome(peerId: string, resumed: boolean): ServerMessage {
    return {
      t: "welcome",
      v: this.version,
      peerId,
      peers: [...this.peers.keys()].filter((p) => p !== peerId),
      iceServers: this.iceServers,
      resumed,
    };
  }

  socketClosed(s: FakeServerSocket): void {
    this.sockets.delete(s);
    s.closed = true;
    const id = s.peerId;
    if (!id) return;
    const p = this.peers.get(id);
    if (!p || p.socket !== s) return;
    p.socket = null;
    p.awayTimer = this.clock.setTimeout(() => {
      if (this.peers.get(id) === p && !p.socket) {
        this.remove(id);
        this.broadcast({ t: "peer-left", peerId: id, reason: "timeout" }, id);
      }
    }, this.graceMs);
  }

  private remove(id: string) {
    const p = this.peers.get(id);
    if (p) this.clock.clearTimeout(p.awayTimer);
    this.peers.delete(id);
  }

  private broadcast(msg: ServerMessage, except: string) {
    for (const p of this.peers.values()) if (p.peerId !== except && p.socket) p.socket.send(msg);
  }

  /** Messages of a given type the server sent to a peer. */
  sentTo(peerId: string, t?: string): ServerMessage[] {
    return this.sent
      .filter((x) => x.to === peerId && typeof x.msg !== "string" && (!t || x.msg.t === t))
      .map((x) => x.msg as ServerMessage);
  }
}
