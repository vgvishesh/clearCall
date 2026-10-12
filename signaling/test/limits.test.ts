import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MAX_PARTICIPANTS } from "@clearcall/protocol";
import { describe, expect, it } from "vitest";
import { CLOSE } from "../src/close-codes.ts";
import {
  RATE_LIMIT_ABUSE_STRIKES,
  RATE_LIMIT_BURST,
  RATE_LIMIT_NOTIFY_INTERVAL_MS,
  RATE_LIMIT_PER_SECOND,
  TokenBucket,
} from "../src/limits.ts";
import { blob, type Client, joined, newRoomId, sleep } from "./helpers.ts";

describe("TokenBucket", () => {
  it("allows the burst, then rejects; first rejection is 'limited', then 'dropped'", () => {
    const b = new TokenBucket(0);
    for (let i = 0; i < RATE_LIMIT_BURST; i++) expect(b.take(0)).toBe("ok");
    expect(b.take(0)).toBe("limited");
    expect(b.take(0)).toBe("dropped");
  });

  it("refills at RATE per second up to the burst", () => {
    const b = new TokenBucket(0);
    for (let i = 0; i < RATE_LIMIT_BURST; i++) b.take(0);
    for (let i = 0; i < RATE_LIMIT_PER_SECOND; i++) expect(b.take(1000)).toBe("ok");
    expect(b.take(1000)).toBe("limited");
    // a long idle period never exceeds the burst
    for (let i = 0; i < RATE_LIMIT_BURST; i++) expect(b.take(1_000_000)).toBe("ok");
    expect(b.take(1_000_000)).not.toBe("ok");
  });

  it("notifies at most once per RATE_LIMIT_NOTIFY_INTERVAL_MS", () => {
    const b = new TokenBucket(0, 1, 1);
    expect(b.take(0)).toBe("ok");
    expect(b.take(0)).toBe("limited");
    expect(b.take(0)).toBe("dropped");
    expect(b.take(1000)).toBe("ok");
    expect(b.take(1000)).toBe("dropped");
    expect(b.take(RATE_LIMIT_NOTIFY_INTERVAL_MS)).toBe("ok");
    expect(b.take(RATE_LIMIT_NOTIFY_INTERVAL_MS)).toBe("limited");
  });

  it("an instant flood → 'abuse' RATE_LIMIT_ABUSE_STRIKES messages past the burst", () => {
    const b = new TokenBucket(0);
    for (let i = 0; i < RATE_LIMIT_BURST; i++) b.take(0);
    for (let i = 1; i < RATE_LIMIT_ABUSE_STRIKES; i++) expect(b.take(0)).not.toBe("abuse");
    expect(b.take(0)).toBe("abuse");
  });

  it("100 msg/s sustained → 'abuse' a few seconds after the burst is spent; 60 msg/s never", () => {
    const run = (intervalMs: number) => {
      const b = new TokenBucket(0);
      for (let t = 0; t < 120_000; t += intervalMs) if (b.take(t) === "abuse") return t;
      return null;
    };
    const t100 = run(10);
    expect(t100).not.toBeNull();
    expect(t100!).toBeLessThan(20_000);
    expect(run(1000 / 60)).toBeNull();
  });

  it("50 msg/s sustained is fine forever", () => {
    const b = new TokenBucket(0);
    for (let t = 0; t < 60_000; t += 20) expect(b.take(t)).toBe("ok");
  });
});

describe("rate limit over WebSockets", () => {
  it("a 10th peer joining a 9-peer room can do the full newcomer burst (hello+offer+ICE to 9 peers) unthrottled", async () => {
    const room = newRoomId();
    const peers: Client[] = [];
    for (let i = 0; i < MAX_PARTICIPANTS - 1; i++) peers.push((await joined(room))[0]);
    const [n] = await joined(room);
    // per existing peer: hello, sdp offer, 20 ICE candidates, end-of-candidates
    const perPeer = 23;
    for (const p of peers) for (let k = 0; k < perPeer; k++) n.signal(p.peerId, blob(200));
    // and every existing peer answers immediately with its own burst towards n
    for (const p of peers) for (let k = 0; k < perPeer; k++) p.signal(n.peerId, blob(200));
    for (const p of peers) {
      for (let k = 0; k < perPeer; k++) expect((await p.next("signal")).from).toBe(n.peerId);
    }
    for (let k = 0; k < perPeer * peers.length; k++) await n.next("signal");
    for (const c of [n, ...peers]) expect(c.received.filter((m) => m.t === "error")).toEqual([]);
  });

  it("flood beyond the burst → exactly one error{rate-limited}, excess dropped, socket stays open", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    const flood = RATE_LIMIT_BURST + 100;
    for (let i = 0; i < flood; i++) a.signal(b.peerId, `m${i}`);
    expect(await a.next("error")).toMatchObject({ code: "rate-limited" });
    await sleep(1000); // refill
    await a.sync();
    const relayed = b.received.filter((m) => m.t === "signal").length;
    expect(relayed).toBeGreaterThanOrEqual(RATE_LIMIT_BURST - 1); // join consumed one token
    expect(relayed).toBeLessThan(flood);
    expect(a.received.filter((m) => m.t === "error" && m.code === "rate-limited")).toHaveLength(1);
    expect(a.closed).toBeNull();
  });

  it("sustained abuse → close 4005 and the peer goes away (may resume)", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    // Tokens refill (50/s) and strikes drain (10/s) while the server works through the flood, so the margin over
    // BURST + STRIKES must cover slow delivery: +100 tripped only if all frames landed within ~1.7 s (flaky on a
    // loaded host); +2000 still trips if delivery takes up to ~35 s.
    for (let i = 0; i < RATE_LIMIT_BURST + RATE_LIMIT_ABUSE_STRIKES + 2000; i++) a.signal(b.peerId, "x");
    expect((await a.closedP).code).toBe(CLOSE.ABUSE);
    const away = await runInDurableObject(env.ROOM.getByName(room), (_i, s) =>
      s.storage.kv.get(`away:${a.peerId}`),
    );
    expect(away).toBeDefined();
  });
});
