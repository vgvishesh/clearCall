import { exports } from "cloudflare:workers";
import { PROTOCOL_VERSION, parseServerMessage, type ServerMessage } from "@clearcall/protocol";
import { expect } from "vitest";

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function randomId(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => B64URL[b & 63]).join("");
}
export const newRoomId = (): string => randomId(22);
export const newPeerId = (): string => randomId(16);
/** A valid opaque blob (the server never looks inside). */
export const blob = (n = 32): string => randomId(n);

type Fetchable = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
export const worker = (exports as unknown as { default: Fetchable }).default;

export interface Closed {
  code: number;
  reason: string;
}

/** A real WebSocket client connected through the Worker to the Room DO. */
export class Client {
  readonly received: ServerMessage[] = [];
  /** Raw frames that failed `parseServerMessage` (should stay empty). */
  readonly invalid: string[] = [];
  private cursor = 0;
  private waiters: (() => void)[] = [];
  closed: Closed | null = null;
  readonly closedP: Promise<Closed>;

  constructor(
    readonly ws: WebSocket,
    readonly roomId: string,
    readonly peerId: string,
  ) {
    let resolveClosed!: (c: Closed) => void;
    this.closedP = new Promise((r) => {
      resolveClosed = r;
    });
    ws.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      if (raw === "pong") return;
      const m = parseServerMessage(raw);
      if (m) this.received.push(m);
      else this.invalid.push(raw);
      this.wake();
    });
    ws.addEventListener("close", (ev) => {
      this.closed = { code: ev.code, reason: ev.reason };
      resolveClosed(this.closed);
      this.wake();
    });
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  join(opts: { resume?: boolean; v?: number; peerId?: string } = {}): void {
    this.send({
      t: "join",
      v: opts.v ?? PROTOCOL_VERSION,
      peerId: opts.peerId ?? this.peerId,
      ...(opts.resume ? { resume: true } : {}),
    });
  }

  signal(to: string, data: string): void {
    this.send({ t: "signal", to, data });
  }

  /** Next not-yet-consumed message, optionally of type `t`; earlier messages of other types are skipped. */
  async next<T extends ServerMessage["t"]>(
    t?: T,
    timeoutMs = 5000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.received.length) {
        const m = this.received[this.cursor++]!;
        if (!t || m.t === t) return m as Extract<ServerMessage, { t: T }>;
      }
      if (this.closed && t) throw new Error(`socket closed (${this.closed.code}) while waiting for ${t}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for ${t ?? "message"}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 250));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Messages received but not yet consumed via `next`. */
  pending(): ServerMessage[] {
    return this.received.slice(this.cursor);
  }

  /** Round-trip through the DO (an unknown-peer error) so that everything sent before has been processed. */
  async sync(): Promise<void> {
    const probe = newPeerId();
    this.signal(probe, "sync");
    for (;;) {
      const e = await this.next("error");
      if (e.code === "unknown-peer" && e.peerId === probe) return;
    }
  }

  close(code = 1000): void {
    this.ws.close(code, "bye");
  }
}

export async function connect(roomId: string, peerId = newPeerId()): Promise<Client> {
  const res = await worker.fetch(`http://localhost/api/room/${roomId}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on response");
  ws.accept();
  return new Client(ws, roomId, peerId);
}

/** Connect and complete a join; returns the client and its welcome. */
export async function joined(
  roomId: string,
  peerId = newPeerId(),
): Promise<[Client, Extract<ServerMessage, { t: "welcome" }>]> {
  const c = await connect(roomId, peerId);
  c.join();
  const w = await c.next("welcome");
  return [c, w];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Assert that no message of type `t` arrives within `ms`. */
export async function expectNo(c: Client, t: ServerMessage["t"], ms = 200): Promise<void> {
  await sleep(ms);
  expect(c.pending().filter((m) => m.t === t)).toEqual([]);
}
