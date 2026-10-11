import { PROTOCOL_VERSION } from "@clearcall/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blob, connect, joined, newPeerId, newRoomId } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function capture(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((l: unknown) => {
    lines.push(String(l));
  });
  return lines;
}

describe("structured room logs", () => {
  it("one JSON line per room event with prefixes only, never blobs or full ids", async () => {
    const lines = capture();
    const room = newRoomId();
    const [a] = await joined(room);
    const [b] = await joined(room);
    const secretBlob = blob(64);
    a.signal(b.peerId, secretBlob);
    await b.next("signal");
    a.signal(newPeerId(), blob());
    await a.next("error");
    const dup = await connect(room, a.peerId);
    dup.join();
    await dup.closedP;
    b.send({ t: "leave" });
    await b.closedP;
    const v = await connect(room);
    v.join({ v: PROTOCOL_VERSION + 1 });
    await v.closedP;

    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events).toEqual(
      expect.arrayContaining([
        { evt: "join", room: room.slice(0, 6), peer: a.peerId.slice(0, 6), n: 1 },
        { evt: "join", room: room.slice(0, 6), peer: b.peerId.slice(0, 6), n: 2 },
        {
          evt: "unknown-peer",
          room: room.slice(0, 6),
          peer: a.peerId.slice(0, 6),
          n: 2,
          code: "unknown-peer",
        },
        { evt: "duplicate-peer", room: room.slice(0, 6), peer: a.peerId.slice(0, 6), n: 2, code: 4003 },
        { evt: "leave", room: room.slice(0, 6), peer: b.peerId.slice(0, 6), n: 1 },
        { evt: "version", room: room.slice(0, 6), peer: v.peerId.slice(0, 6), n: 1, code: 4002 },
      ]),
    );
    for (const l of lines) {
      expect(l).not.toContain(secretBlob);
      expect(l).not.toContain(room);
      expect(l).not.toContain(a.peerId);
      expect(l).not.toContain(b.peerId);
      expect(Object.keys(JSON.parse(l)).every((k) => ["evt", "room", "peer", "n", "code"].includes(k))).toBe(
        true,
      );
    }
    // relayed signals themselves are not logged
    expect(events.filter((e) => e.evt === "signal")).toEqual([]);
  });
});
