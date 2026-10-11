import { MAX_MESSAGE_BYTES, MAX_PARTICIPANTS, PROTOCOL_VERSION } from "@clearcall/protocol";
import { describe, expect, it } from "vitest";
import { CLOSE } from "../src/close-codes.ts";
import * as main from "../src/index.ts";
import { blob, connect, expectNo, joined, newPeerId, newRoomId, worker } from "./helpers.ts";

describe("worker routes", () => {
  it("main module exports only handlers/classes (workerd rejects anything else)", () => {
    expect(Object.keys(main).sort()).toEqual(["Room", "default"]);
  });

  it("GET /api/health → 200 {ok:true}", async () => {
    const res = await worker.fetch("http://localhost/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("bad room id → 400 before touching a DO", async () => {
    for (const id of ["short", "x".repeat(23), "has space in it 123456", "bad*chars!!!!!!!!!!!!!"]) {
      const res = await worker.fetch(`http://localhost/api/room/${encodeURIComponent(id)}`, {
        headers: { Upgrade: "websocket" },
      });
      expect(res.status, id).toBe(400);
    }
  });

  it("room without Upgrade: websocket → 426", async () => {
    const res = await worker.fetch(`http://localhost/api/room/${newRoomId()}`);
    expect(res.status).toBe(426);
  });

  it("unknown /api path → 404", async () => {
    for (const p of ["/api/nope", "/api/room", "/api/room/a/b", "/api/"]) {
      const res = await worker.fetch(`http://localhost${p}`);
      expect(res.status, p).toBe(404);
    }
  });
});

describe("join", () => {
  it("first peer gets welcome with no peers and STUN", async () => {
    const room = newRoomId();
    const [a, w] = await joined(room);
    expect(w).toMatchObject({
      t: "welcome",
      v: PROTOCOL_VERSION,
      peerId: a.peerId,
      peers: [],
      resumed: false,
    });
    expect(w.iceServers).toContainEqual({ urls: "stun:stun.cloudflare.com:3478" });
    expect(a.invalid).toEqual([]);
  });

  it("welcome.peers lists others in join order; others get peer-joined; joiner doesn't", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b, wb] = await joined(room);
    expect(wb.peers).toEqual([a.peerId]);
    expect(await a.next("peer-joined")).toEqual({ t: "peer-joined", peerId: b.peerId });
    const [c, wc] = await joined(room);
    expect(wc.peers).toEqual([a.peerId, b.peerId]);
    expect((await a.next("peer-joined")).peerId).toBe(c.peerId);
    expect((await b.next("peer-joined")).peerId).toBe(c.peerId);
    await expectNo(c, "peer-joined");
  });

  it("first message must be join → error{not-joined} (non-fatal)", async () => {
    const c = await connect(newRoomId());
    c.signal(newPeerId(), blob());
    expect(await c.next("error")).toMatchObject({ code: "not-joined" });
    c.join();
    expect((await c.next("welcome")).peerId).toBe(c.peerId);
  });

  it("version mismatch → error{version} and close 4002", async () => {
    const c = await connect(newRoomId());
    c.join({ v: PROTOCOL_VERSION + 1 });
    expect(await c.next("error")).toMatchObject({ code: "version" });
    expect((await c.closedP).code).toBe(CLOSE.VERSION);
  });

  it("room full: 11th peer → error{room-full} and close 4001", async () => {
    const room = newRoomId();
    const peers = [];
    for (let i = 0; i < MAX_PARTICIPANTS; i++) peers.push((await joined(room))[0]);
    const late = await connect(room);
    late.join();
    expect(await late.next("error")).toMatchObject({ code: "room-full" });
    expect((await late.closedP).code).toBe(CLOSE.ROOM_FULL);
    // nobody saw it
    for (const p of peers)
      expect(p.pending().filter((m) => m.t === "peer-joined" && m.peerId === late.peerId)).toEqual([]);
  });

  it("duplicate peerId without resume → error{duplicate-peer} and close 4003; original unaffected", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    const dup = await connect(room, a.peerId);
    dup.join();
    expect(await dup.next("error")).toMatchObject({ code: "duplicate-peer" });
    expect((await dup.closedP).code).toBe(CLOSE.DUPLICATE_PEER);
    b.signal(a.peerId, "still-here");
    expect(await a.next("signal")).toEqual({ t: "signal", from: b.peerId, data: "still-here" });
  });

  it("second join on a joined socket → bad-message (non-fatal)", async () => {
    const [a] = await joined(newRoomId());
    a.join();
    expect(await a.next("error")).toMatchObject({ code: "bad-message" });
    await a.sync();
    expect(a.closed).toBeNull();
  });
});

describe("signal relay", () => {
  it("forwards to the target only, verbatim, with `from` set (relay isolation smoke)", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    const [c] = await joined(room);
    const data = blob(2000);
    a.signal(b.peerId, data);
    expect(await b.next("signal")).toEqual({ t: "signal", from: a.peerId, data });
    b.signal(a.peerId, "reply");
    expect(await a.next("signal")).toEqual({ t: "signal", from: b.peerId, data: "reply" });
    await c.sync();
    expect(c.pending().filter((m) => m.t === "signal")).toEqual([]);
  });

  it("does not leak across rooms", async () => {
    const [a] = await joined(newRoomId());
    const [b] = await joined(newRoomId());
    a.signal(b.peerId, blob());
    expect(await a.next("error")).toEqual({ t: "error", code: "unknown-peer", peerId: b.peerId });
    await expectNo(b, "signal");
  });

  it("unknown target or self → error{unknown-peer, peerId} (non-fatal)", async () => {
    const [a] = await joined(newRoomId());
    const ghost = newPeerId();
    a.signal(ghost, blob());
    expect(await a.next("error")).toEqual({ t: "error", code: "unknown-peer", peerId: ghost });
    a.signal(a.peerId, blob());
    expect(await a.next("error")).toEqual({ t: "error", code: "unknown-peer", peerId: a.peerId });
    expect(a.closed).toBeNull();
  });

  it("preserves order of many signals", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    for (let i = 0; i < 50; i++) a.signal(b.peerId, `m${i}`);
    for (let i = 0; i < 50; i++) expect((await b.next("signal")).data).toBe(`m${i}`);
  });
});

describe("bad input", () => {
  it("invalid JSON / invalid shapes → error{bad-message}, socket stays open", async () => {
    const [a] = await joined(newRoomId());
    for (const raw of [
      "not json",
      "{}",
      JSON.stringify({ t: "signal", to: "short", data: "x" }),
      JSON.stringify({ t: "signal", to: newPeerId(), data: "has spaces" }),
      JSON.stringify({ t: "nope" }),
      "[]",
    ]) {
      a.send(raw);
      expect((await a.next("error")).code, raw).toBe("bad-message");
    }
    expect(a.closed).toBeNull();
  });

  it("binary frames → error{bad-message}", async () => {
    const [a] = await joined(newRoomId());
    a.ws.send(new Uint8Array([1, 2, 3]));
    expect((await a.next("error")).code).toBe("bad-message");
  });

  it("message > MAX_MESSAGE_BYTES → error{too-large}; largest relayable signal goes through", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    // The relayed frame ({"t":"signal","from":…}) is 2 bytes longer than the inbound one ({…"to":…}); the
    // server refuses inbound signals whose relayed form would exceed MAX_MESSAGE_BYTES (receivers reject those).
    const outEnvelope = JSON.stringify({ t: "signal", from: a.peerId, data: "" }).length;
    const largest = blob(MAX_MESSAGE_BYTES - outEnvelope);
    a.signal(b.peerId, largest);
    const got = await b.next("signal");
    expect(got.data).toBe(largest);
    expect(JSON.stringify(got).length).toBe(MAX_MESSAGE_BYTES);
    expect(b.invalid).toEqual([]);
    a.signal(b.peerId, `${largest}x`);
    expect((await a.next("error")).code).toBe("too-large");
    a.signal(b.peerId, blob(MAX_MESSAGE_BYTES));
    expect((await a.next("error")).code).toBe("too-large");
    // multi-byte characters count as bytes, not UTF-16 units
    a.send(JSON.stringify({ t: "signal", to: b.peerId, data: "é".repeat(MAX_MESSAGE_BYTES / 2) }));
    expect((await a.next("error")).code).toBe("too-large");
    expect(a.closed).toBeNull();
  });
});

describe("leave", () => {
  it("leave → others get peer-left{left} immediately; leaver closed with 1000; slot freed", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    await a.next("peer-joined");
    b.send({ t: "leave" });
    expect(await a.next("peer-left")).toEqual({ t: "peer-left", peerId: b.peerId, reason: "left" });
    expect((await b.closedP).code).toBe(CLOSE.LEFT);
    const [, wc] = await joined(room);
    expect(wc.peers).toEqual([a.peerId]);
  });

  it("the same peerId can join fresh after leaving", async () => {
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    b.send({ t: "leave" });
    await a.next("peer-left");
    const again = await connect(room, b.peerId);
    again.join();
    expect(await again.next("welcome")).toMatchObject({ resumed: false, peers: [a.peerId] });
  });
});
