import {
  deriveRoomKeys,
  generatePeerId,
  generateSecret,
  HEARTBEAT_INTERVAL_MS,
  type SignalPayload,
} from "@clearcall/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { createLog } from "./log.ts";
import {
  backoffDelay,
  HEARTBEAT_DEAD_AFTER_MS,
  roomCipher,
  roomUrl,
  type SignalCipher,
  SignalingClient,
  type SignalingHandlers,
  type SignalingOptions,
  type SignalingStatus,
} from "./signaling-client.ts";
import { advanceAndSettle, FakeClock, settle } from "./testing/fake-clock.ts";
import { FakeSignalingServer } from "./testing/fake-signaling.ts";

let cipher: SignalCipher;
beforeAll(async () => {
  cipher = roomCipher(await deriveRoomKeys(generateSecret()));
});

interface Rec {
  client: SignalingClient;
  statuses: SignalingStatus[];
  signals: { from: string; payload: SignalPayload }[];
  events: string[];
  fatal: string[];
  welcomes: { peers: string[]; resumed: boolean }[];
  log: ReturnType<typeof createLog>;
}

function mk(
  server: FakeSignalingServer,
  clock: FakeClock,
  extra: Partial<SignalingHandlers> = {},
  id = generatePeerId(),
  opts: Partial<SignalingOptions> = {},
) {
  const rec: Rec = { statuses: [], signals: [], events: [], fatal: [], welcomes: [] } as unknown as Rec;
  const log = createLog({ now: clock.now, consoleLevel: null });
  rec.client = new SignalingClient({
    url: "ws://test/api/room/x",
    peerId: id,
    cipher,
    WebSocket: server.WebSocket,
    clock,
    random: () => 0.5,
    log: log.scope("signaling"),
    handlers: {
      status: (s) => rec.statuses.push(s),
      welcome: (w) => rec.welcomes.push({ peers: w.peers, resumed: w.resumed }),
      peerJoined: (p) => rec.events.push(`joined:${p}`),
      peerLeft: (p, r) => rec.events.push(`left:${p}:${r}`),
      signal: (from, payload) => rec.signals.push({ from, payload }),
      error: (code, peerId) => rec.events.push(`error:${code}:${peerId ?? ""}`),
      fatal: (code) => rec.fatal.push(code),
      ...extra,
    },
    ...opts,
  });
  rec.log = log;
  return rec;
}

function setup() {
  const clock = new FakeClock();
  const server = new FakeSignalingServer(clock);
  return { clock, server };
}

describe("helpers", () => {
  it("roomUrl picks ws/wss from the page protocol", () => {
    expect(roomUrl({ protocol: "https:", host: "a.b" }, "R")).toBe("wss://a.b/api/room/R");
    expect(roomUrl({ protocol: "http:", host: "localhost:8787" }, "R")).toBe(
      "ws://localhost:8787/api/room/R",
    );
  });

  it("backoff grows 0.5 s → 8 s with jitter in [base/2, base]", () => {
    const lo = [0, 1, 2, 3, 4, 5, 8].map((n) => backoffDelay(n, () => 0));
    const hi = [0, 1, 2, 3, 4, 5, 8].map((n) => backoffDelay(n, () => 1));
    expect(hi).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
    expect(lo).toEqual([250, 500, 1000, 2000, 4000, 4000, 4000]);
  });
});

describe("SignalingClient", () => {
  it("joins, sees peers join, relays encrypted payloads in order", async () => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    a.client.connect();
    await settle();
    expect(a.statuses).toEqual(["connecting", "open"]);
    expect(a.welcomes).toEqual([{ peers: [], resumed: false }]);

    const b = mk(server, clock);
    b.client.connect();
    await settle();
    expect(b.welcomes[0]!.peers).toEqual([a.client.peerId]);
    expect(a.events).toEqual([`joined:${b.client.peerId}`]);

    for (let i = 0; i < 20; i++) b.client.send(a.client.peerId, { k: "hello", name: `marker-${i}` });
    await settle(40);
    expect(a.signals.map((s) => (s.payload as { name: string }).name)).toEqual(
      Array.from({ length: 20 }, (_, i) => `marker-${i}`),
    );
    expect(a.signals.every((s) => s.from === b.client.peerId)).toBe(true);
    // The server only ever saw opaque blobs.
    const relayed = server.received.filter((r) => typeof r.msg !== "string" && r.msg.t === "signal");
    expect(relayed).toHaveLength(20);
    expect(JSON.stringify(relayed)).not.toContain("marker-");
  });

  it("drops undecryptable signals (wrong key / tampered / misaddressed)", async () => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    const b = mk(server, clock);
    a.client.connect();
    b.client.connect();
    await settle();
    const other = roomCipher(await deriveRoomKeys(generateSecret()));
    const blob = await other.encrypt(b.client.peerId, a.client.peerId, { k: "hello", name: "x" });
    const sock = server.peers.get(a.client.peerId)!.socket!;
    sock.send({ t: "signal", from: b.client.peerId, data: blob });
    // addressed to someone else
    const mis = await cipher.encrypt(b.client.peerId, generatePeerId(), { k: "hello", name: "y" });
    sock.send({ t: "signal", from: b.client.peerId, data: mis });
    sock.send({ t: "signal", from: b.client.peerId, data: "AAAA" });
    await settle(30);
    expect(a.signals).toEqual([]);
  });

  it("reports unknown-peer as a non-fatal error with the peer id", async () => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    a.client.connect();
    await settle();
    const ghost = generatePeerId();
    a.client.send(ghost, { k: "hello", name: "" });
    await settle(30);
    expect(a.events).toEqual([`error:unknown-peer:${ghost}`]);
    expect(a.statuses.at(-1)).toBe("open");
  });

  it("reconnects with backoff after a drop, resumes the same peerId and flushes the outbox", async () => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    const b = mk(server, clock);
    a.client.connect();
    b.client.connect();
    await settle();
    server.dropPeer(a.client.peerId);
    await settle();
    expect(a.statuses.at(-1)).toBe("reconnecting");
    // Sent while down → outbox.
    a.client.send(b.client.peerId, { k: "hello", name: "while-down" });
    await settle(30);
    expect(b.signals).toHaveLength(0);
    await advanceAndSettle(clock, 400); // first backoff = 375ms with random 0.5
    expect(a.statuses.at(-1)).toBe("open");
    const joins = server.received.filter((r) => typeof r.msg !== "string" && r.msg.t === "join");
    expect(joins.at(-1)!.msg).toEqual({ t: "join", v: 1, peerId: a.client.peerId, resume: true });
    expect(a.welcomes.at(-1)).toEqual({ peers: [b.client.peerId], resumed: true });
    await settle(20);
    expect(b.signals.map((s) => (s.payload as { name: string }).name)).toEqual(["while-down"]);
    // No broadcasts on resume.
    expect(b.events).toEqual([]);
  });

  it("backs off exponentially while the server refuses, then gives up after 60 s", async () => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    a.client.connect();
    await settle();
    server.refuse = true;
    server.dropPeer(a.client.peerId);
    await settle();
    const before = server.connections;
    await advanceAndSettle(clock, 30_000, 250);
    const attempts30 = server.connections - before;
    // 375, 750, 1500, 3000, 6000, 6000... → ~8 attempts in 30 s, not hundreds
    expect(attempts30).toBeGreaterThanOrEqual(5);
    expect(attempts30).toBeLessThanOrEqual(10);
    expect(a.fatal).toEqual([]);
    await advanceAndSettle(clock, 31_000, 500);
    expect(a.fatal).toEqual(["unavailable"]);
    expect(a.client.status).toBe("closed");
    const n = server.connections;
    await advanceAndSettle(clock, 30_000, 1000);
    expect(server.connections).toBe(n);
  });

  it("never gives up while the call is alive: keeps retrying with backoff capped at ~30 s", async () => {
    const { clock, server } = setup();
    const alive = true;
    const a = mk(server, clock, {}, undefined, { isCallAlive: () => alive });
    a.client.connect();
    await settle();
    server.refuse = true;
    server.dropPeer(a.client.peerId, 4006);
    await advanceAndSettle(clock, 120_000, 1000);
    expect(a.fatal).toEqual([]);
    expect(a.client.status).toBe("reconnecting");
    // Backoff is capped at ~30 s (jittered 15–30 s): a handful of attempts per minute, never none.
    const before = server.connections;
    await advanceAndSettle(clock, 60_000, 1000);
    const perMinute = server.connections - before;
    expect(perMinute).toBeGreaterThanOrEqual(2);
    expect(perMinute).toBeLessThanOrEqual(4);
    expect(a.fatal).toEqual([]);
    expect(a.log.entries().some((e) => e.msg === "giving up")).toBe(false);
    // Server comes back (its resume grace long expired → resumed:false, the mesh rebuilds per FLOWS §4).
    server.refuse = false;
    await advanceAndSettle(clock, 31_000, 500);
    expect(a.client.status).toBe("open");
    expect(a.welcomes).toHaveLength(2);
    expect(a.fatal).toEqual([]);
  });

  it("gives up only once no pair has been connected for 60 s", async () => {
    const { clock, server } = setup();
    let alive = true;
    const a = mk(server, clock, {}, undefined, { isCallAlive: () => alive });
    a.client.connect();
    await settle();
    server.refuse = true;
    server.dropPeer(a.client.peerId);
    await advanceAndSettle(clock, 90_000, 1000);
    expect(a.fatal).toEqual([]);
    alive = false; // the last P2P pair dies
    await advanceAndSettle(clock, 58_000, 1000);
    expect(a.fatal).toEqual([]);
    await advanceAndSettle(clock, 3_000, 500);
    expect(a.fatal).toEqual(["unavailable"]);
    expect(a.client.status).toBe("closed");
  });

  it("first join gives up after 20 s", async () => {
    const { clock, server } = setup();
    server.refuse = true;
    const a = mk(server, clock);
    a.client.connect();
    await advanceAndSettle(clock, 19_000, 250);
    expect(a.fatal).toEqual([]);
    expect(a.statuses).toEqual(["connecting"]);
    await advanceAndSettle(clock, 2_000, 250);
    expect(a.fatal).toEqual(["unavailable"]);
  });

  it("abandons a hanging connect attempt after the connect timeout", async () => {
    const { clock, server } = setup();
    server.hang = true;
    const a = mk(server, clock);
    a.client.connect();
    await advanceAndSettle(clock, 10_100, 500);
    server.hang = false;
    await advanceAndSettle(clock, 1_000, 100);
    expect(a.statuses.at(-1)).toBe("open");
    expect(server.connections).toBe(2);
  });

  it("sends heartbeats and reconnects when pongs stop", async () => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    a.client.connect();
    await settle();
    await advanceAndSettle(clock, 15_000, 1000);
    expect(server.received.filter((r) => r.msg === "ping")).toHaveLength(1);
    server.answerPings = false;
    await advanceAndSettle(clock, HEARTBEAT_DEAD_AFTER_MS + 10_000, 1000);
    expect(a.statuses).toContain("reconnecting");
    expect(a.statuses.at(-1)).toBe("open"); // reconnected (server still accepts)
  });

  it(`declares the socket dead ${HEARTBEAT_DEAD_AFTER_MS / 1000} s after the last message (± one check), not before`, async () => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    a.client.connect();
    await settle();
    await advanceAndSettle(clock, 15_000, 100); // ping → pong: last message at ~15 s
    expect(server.connections).toBe(1);
    server.answerPings = false;
    const lastRx = clock.now();
    await advanceAndSettle(clock, HEARTBEAT_DEAD_AFTER_MS - 100, 100);
    expect(a.statuses).not.toContain("reconnecting"); // no false positive before the cutoff
    let detectedAt: number | null = null;
    for (let i = 0; i < 200 && detectedAt === null; i++) {
      await advanceAndSettle(clock, 100, 100);
      if (a.statuses.includes("reconnecting")) detectedAt = clock.now();
    }
    expect(detectedAt! - lastRx).toBeGreaterThan(HEARTBEAT_DEAD_AFTER_MS);
    expect(detectedAt! - lastRx).toBeLessThanOrEqual(HEARTBEAT_DEAD_AFTER_MS + 5_000);
    expect(HEARTBEAT_DEAD_AFTER_MS).toBeLessThan(4 * HEARTBEAT_INTERVAL_MS); // resume before the server's cutoff
  });

  it("two consecutive lost pongs under load do not drop a live socket", async () => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    a.client.connect();
    await settle();
    await advanceAndSettle(clock, 15_000, 100);
    server.answerPings = false; // pongs for the pings at 30 s and 45 s are lost
    await advanceAndSettle(clock, 30_000 + 100, 100);
    server.answerPings = true; // the one at 60 s gets through
    await advanceAndSettle(clock, 30_000, 100);
    expect(a.statuses).not.toContain("reconnecting");
    expect(server.connections).toBe(1);
  });

  it("discardQueued drops one peer's stale outbox entries; later sends keep order behind the outbox", async () => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    const b = mk(server, clock);
    const c = mk(server, clock);
    for (const x of [a, b, c]) x.client.connect();
    await settle();
    server.dropPeer(a.client.peerId, 4006);
    await settle();
    a.client.send(b.client.peerId, { k: "hello", name: "stale-b" });
    a.client.send(c.client.peerId, { k: "hello", name: "c-1" });
    a.client.discardQueued(b.client.peerId); // the pair with b was rebuilt
    a.client.send(b.client.peerId, { k: "hello", name: "fresh-b" });
    a.client.send(c.client.peerId, { k: "hello", name: "c-2" });
    await advanceAndSettle(clock, 400);
    expect(a.client.status).toBe("open");
    await settle(20);
    const names = (r: Rec) => r.signals.map((s) => (s.payload as { name: string }).name);
    expect(names(b)).toEqual(["fresh-b"]);
    expect(names(c)).toEqual(["c-1", "c-2"]);
  });

  it("after the grace window expires the server treats it as fresh: resumed:false, outbox discarded", async () => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    const b = mk(server, clock);
    a.client.connect();
    b.client.connect();
    await settle();
    server.refuse = true;
    server.dropPeer(a.client.peerId);
    await settle();
    a.client.send(b.client.peerId, { k: "hello", name: "stale" });
    await advanceAndSettle(clock, 21_000, 500);
    expect(b.events).toContain(`left:${a.client.peerId}:timeout`);
    server.refuse = false;
    a.client.nudge();
    await advanceAndSettle(clock, 9_000, 500);
    expect(a.welcomes.at(-1)).toEqual({ peers: [b.client.peerId], resumed: false });
    expect(b.events.at(-1)).toBe(`joined:${a.client.peerId}`);
    await settle(20);
    expect(b.signals).toEqual([]);
  });

  it.each([
    ["room-full", { capacity: 1 }],
    ["version", { version: 2 }],
  ] as const)("fatal %s stops the client without retrying", async (code, opts) => {
    const clock = new FakeClock();
    const server = new FakeSignalingServer(clock, opts);
    if (code === "room-full") {
      const first = mk(server, clock);
      first.client.connect();
      await settle();
    }
    const a = mk(server, clock);
    a.client.connect();
    await settle();
    expect(a.fatal).toEqual([code]);
    const n = server.connections;
    await advanceAndSettle(clock, 10_000, 1000);
    expect(server.connections).toBe(n);
    expect(a.client.status).toBe("closed");
  });

  it("duplicate-peer is fatal", async () => {
    const { clock, server } = setup();
    const id = generatePeerId();
    mk(server, clock, {}, id).client.connect();
    await settle();
    const dup = mk(server, clock, {}, id);
    dup.client.connect();
    await settle();
    expect(dup.fatal).toEqual(["duplicate-peer"]);
  });

  it("leave sends leave and others see peer-left immediately", async () => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    const b = mk(server, clock);
    a.client.connect();
    b.client.connect();
    await settle();
    a.client.leave();
    await settle();
    expect(b.events).toContain(`left:${a.client.peerId}:left`);
    expect(a.client.status).toBe("closed");
    const n = server.connections;
    await advanceAndSettle(clock, 10_000, 1000);
    expect(server.connections).toBe(n);
  });

  it.each([4005, 4006, 1006, 1011])("close code %i → resume", async (code) => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    a.client.connect();
    await settle();
    server.dropPeer(a.client.peerId, code);
    await advanceAndSettle(clock, 1_000, 100);
    expect(a.fatal).toEqual([]);
    expect(a.welcomes.at(-1)).toEqual({ peers: [], resumed: true });
  });

  it.each([
    [4004, "replaced"],
    [4001, "room-full"],
    [4002, "version"],
    [4003, "duplicate-peer"],
  ] as const)("close code %i alone is fatal (%s), no reconnect", async (code, fatal) => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    a.client.connect();
    await settle();
    const n = server.connections;
    server.dropPeer(a.client.peerId, code);
    await advanceAndSettle(clock, 10_000, 500);
    expect(a.fatal).toEqual([fatal]);
    expect(server.connections).toBe(n);
  });

  it("a socket lost after join was sent (before welcome) retries as a resume, avoiding duplicate-peer", async () => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    a.client.connect();
    // join is delivered, but the socket dies before the welcome reaches us
    await Promise.resolve();
    await Promise.resolve();
    await settle(1);
    server.dropPeer(a.client.peerId);
    await advanceAndSettle(clock, 1_000, 100);
    expect(a.fatal).toEqual([]);
    expect(a.statuses.at(-1)).toBe("open");
    const joins = server.received.filter((r) => typeof r.msg !== "string" && r.msg.t === "join");
    expect(joins.length).toBeGreaterThanOrEqual(2);
    expect((joins.at(-1)!.msg as { resume?: boolean }).resume).toBe(true);
  });

  it("drops a signal that would exceed the Worker's size limit", async () => {
    const { clock, server } = setup();
    const a = mk(server, clock);
    const b = mk(server, clock);
    a.client.connect();
    b.client.connect();
    await settle();
    a.client.send(b.client.peerId, { k: "sdp", description: { type: "offer", sdp: "x".repeat(60_000) } });
    a.client.send(b.client.peerId, { k: "hello", name: "ok" });
    await settle(30);
    expect(b.signals.map((x) => x.payload.k)).toEqual(["hello"]);
  });
});
