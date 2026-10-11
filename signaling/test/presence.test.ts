import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MAX_PARTICIPANTS } from "@clearcall/protocol";
import { describe, expect, it } from "vitest";
import { CLOSE } from "../src/close-codes.ts";
import { type Client, connect, expectNo, joined, newPeerId, newRoomId, sleep } from "./helpers.ts";

const stub = (roomId: string) => env.ROOM.getByName(roomId);

interface AwayRecord {
  seq: number;
  joinedAt: number;
  awayUntil: number;
}

/** Keys + values in the room's storage. */
function storage(roomId: string): Promise<Record<string, unknown>> {
  return runInDurableObject(stub(roomId), (_i, state) => Object.fromEntries(state.storage.kv.list()));
}

/** Pretend the resume grace of every away peer has expired. */
function expireAway(roomId: string): Promise<void> {
  return runInDurableObject(stub(roomId), (_i, state) => {
    for (const [k, v] of Array.from(state.storage.kv.list<AwayRecord>({ prefix: "away:" })))
      state.storage.kv.put(k, { ...v, awayUntil: Date.now() - 1 });
  });
}

/** Pretend `peerId`'s socket has been silent (no message, no ping) for a long time. */
function silence(roomId: string, peerId: string): Promise<void> {
  return runInDurableObject(stub(roomId), (_i, state) => {
    for (const ws of state.getWebSockets()) {
      const a = ws.deserializeAttachment() as { peer?: { peerId: string }; seenAt: number } | null;
      if (a?.peer?.peerId === peerId) ws.serializeAttachment({ ...a, seenAt: 0 });
    }
  });
}

/** Close a client and wait until the DO has marked it away. */
async function drop(c: Client): Promise<void> {
  c.close();
  await c.closedP;
  for (let i = 0; i < 50; i++) {
    const s = await storage(c.roomId);
    if (`away:${c.peerId}` in s) return;
    await sleep(20);
  }
  throw new Error("peer never marked away");
}

describe("away + resume", () => {
  it("socket drop → away: no peer-left yet, still in welcome.peers, signals get unknown-peer", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    await drop(b);
    await expectNo(a, "peer-left");
    a.signal(b.peerId, "x");
    expect(await a.next("error")).toEqual({ t: "error", code: "unknown-peer", peerId: b.peerId });
    const [, wc] = await joined(room);
    expect(wc.peers).toEqual([a.peerId, b.peerId]);
  });

  it("resume within grace → welcome{resumed:true}, no broadcasts, relay resumes on the new socket", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    await a.next("peer-joined");
    await drop(b);
    const b2 = await connect(room, b.peerId);
    b2.join({ resume: true });
    expect(await b2.next("welcome")).toMatchObject({ peerId: b.peerId, peers: [a.peerId], resumed: true });
    await expectNo(a, "peer-joined");
    await expectNo(a, "peer-left");
    a.signal(b.peerId, "again");
    expect(await b2.next("signal")).toEqual({ t: "signal", from: a.peerId, data: "again" });
    expect(await storage(room)).not.toHaveProperty(`away:${b.peerId}`);
  });

  it("resume keeps the original join order", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    const [c] = await joined(room);
    await drop(a);
    const a2 = await connect(room, a.peerId);
    a2.join({ resume: true });
    await a2.next("welcome");
    const [, wd] = await joined(room);
    expect(wd.peers).toEqual([a.peerId, b.peerId, c.peerId]);
  });

  it("resume while the old socket is still open → old socket closed 4004, its close is ignored", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    await a.next("peer-joined");
    const b2 = await connect(room, b.peerId);
    b2.join({ resume: true });
    expect(await b2.next("welcome")).toMatchObject({ resumed: true, peers: [a.peerId] });
    expect((await b.closedP).code).toBe(CLOSE.REPLACED);
    await sleep(100);
    // the stale socket's close did not mark b away
    expect(Object.keys(await storage(room)).filter((k) => k.startsWith("away:"))).toEqual([]);
    await expectNo(a, "peer-left");
    await expectNo(a, "peer-joined");
    a.signal(b.peerId, "to-new");
    expect((await b2.next("signal")).data).toBe("to-new");
  });

  it("resume with an unknown peerId is a fresh join", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const c = await connect(room);
    c.join({ resume: true });
    expect(await c.next("welcome")).toMatchObject({ resumed: false, peers: [a.peerId] });
    expect((await a.next("peer-joined")).peerId).toBe(c.peerId);
  });

  it("away peer rejoining without resume → duplicate-peer", async () => {
    const room = newRoomId();
    await joined(room);
    const [b] = await joined(room);
    await drop(b);
    const b2 = await connect(room, b.peerId);
    b2.join();
    expect((await b2.next("error")).code).toBe("duplicate-peer");
    expect((await b2.closedP).code).toBe(CLOSE.DUPLICATE_PEER);
  });

  it("capacity counts away peers; the away peer can still resume into a full room", async () => {
    const room = newRoomId();
    const peers: Client[] = [];
    for (let i = 0; i < MAX_PARTICIPANTS; i++) peers.push((await joined(room))[0]);
    const gone = peers[3]!;
    await drop(gone);
    const late = await connect(room);
    late.join();
    expect((await late.next("error")).code).toBe("room-full");
    const back = await connect(room, gone.peerId);
    back.join({ resume: true });
    expect(await back.next("welcome")).toMatchObject({ resumed: true });
    await sleep(100);
    for (const p of peers.slice(0, 3)) {
      // only the original peer-joined, nothing for the resume
      expect(p.received.filter((m) => m.t === "peer-joined" && m.peerId === gone.peerId)).toHaveLength(1);
    }
  });
});

describe("alarm: grace timeout", () => {
  it("expired away peer → peer-left{timeout} to everyone; slot freed; resume becomes a fresh join", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    const [c] = await joined(room);
    await drop(c);
    await expireAway(room);
    expect(await runDurableObjectAlarm(stub(room))).toBe(true);
    expect(await a.next("peer-left")).toEqual({ t: "peer-left", peerId: c.peerId, reason: "timeout" });
    expect(await b.next("peer-left")).toEqual({ t: "peer-left", peerId: c.peerId, reason: "timeout" });
    const c2 = await connect(room, c.peerId);
    c2.join({ resume: true });
    expect(await c2.next("welcome")).toMatchObject({ resumed: false, peers: [a.peerId, b.peerId] });
    expect((await a.next("peer-joined")).peerId).toBe(c.peerId);
  });

  it("schedules the alarm for the grace expiry and keeps non-expired peers", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    const before = Date.now();
    await drop(b);
    const alarm = await runInDurableObject(stub(room), (_i, s) => s.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(before + 20_000 + 1000);
    expect(await runDurableObjectAlarm(stub(room))).toBe(true);
    await expectNo(a, "peer-left");
    expect(await storage(room)).toHaveProperty(`away:${b.peerId}`);
  });

  it("last peer timing out wipes the room's storage and alarm", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    await drop(a);
    await expireAway(room);
    await runDurableObjectAlarm(stub(room));
    expect(await storage(room)).toEqual({});
    expect(await runInDurableObject(stub(room), (_i, s) => s.storage.getAlarm())).toBeNull();
  });

  it("everyone leaving wipes the room's storage", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    a.send({ t: "leave" });
    b.send({ t: "leave" });
    await a.closedP;
    await b.closedP;
    await sleep(50);
    expect(await storage(room)).toEqual({});
  });
});

describe("alarm: dead sockets", () => {
  it("auto-responds to the heartbeat", async () => {
    const [a] = await joined(newRoomId());
    const pong = new Promise<string>((resolve) =>
      a.ws.addEventListener("message", (ev) => ev.data === "pong" && resolve(ev.data)),
    );
    a.ws.send("ping");
    expect(await pong).toBe("pong");
  });

  it("silent socket → closed 4006 and marked away; a socket that pings survives", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    const pong = new Promise((resolve) =>
      a.ws.addEventListener("message", (ev) => ev.data === "pong" && resolve(0)),
    );
    a.ws.send("ping");
    await pong;
    await silence(room, a.peerId);
    await silence(room, b.peerId);
    await runDurableObjectAlarm(stub(room));
    expect((await b.closedP).code).toBe(CLOSE.DEAD);
    expect(a.closed).toBeNull();
    expect(await storage(room)).toHaveProperty(`away:${b.peerId}`);
    await expectNo(a, "peer-left");
    // dead peer can resume
    const b2 = await connect(room, b.peerId);
    b2.join({ resume: true });
    expect(await b2.next("welcome")).toMatchObject({ resumed: true, peers: [a.peerId] });
  });

  it("keeps a dead-check alarm while sockets are open", async () => {
    const room = newRoomId();
    await joined(room);
    const alarm = await runInDurableObject(stub(room), (_i, s) => s.storage.getAlarm());
    expect(alarm).not.toBeNull();
    await runDurableObjectAlarm(stub(room));
    expect(await runInDurableObject(stub(room), (_i, s) => s.storage.getAlarm())).not.toBeNull();
  });
});

describe("hibernation", () => {
  it("roster, join order and relay survive eviction (attachments + storage)", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    const [c] = await joined(room);
    await drop(b);
    await evictDurableObject(stub(room));
    a.signal(c.peerId, "after-evict");
    expect(await c.next("signal")).toEqual({ t: "signal", from: a.peerId, data: "after-evict" });
    const [, wd] = await joined(room, newPeerId());
    expect(wd.peers).toEqual([a.peerId, b.peerId, c.peerId]);
    const b2 = await connect(room, b.peerId);
    b2.join({ resume: true });
    expect(await b2.next("welcome")).toMatchObject({ resumed: true });
  });
});
