import { describe, expect, it } from "vitest";
import { synthTimeline } from "./fixtures.ts";
import { increase, summarizeTimeline } from "./metrics.ts";
import { withQa } from "./peers.ts";

describe("lab variant flags", () => {
  it("adds app flags to every page URL and keeps path + fragment", () => {
    const u = new URL(withQa("http://h:8797/r/abc?x=1#k=s", "abr=40000&ns=0"));
    expect(u.pathname).toBe("/r/abc");
    expect(u.hash).toBe("#k=s");
    expect(Object.fromEntries(u.searchParams)).toEqual({ x: "1", abr: "40000", ns: "0", qa: "1" });
    expect(withQa("http://h/")).toBe("http://h/?qa=1");
  });
});

describe("audio send rate", () => {
  it("derives audio kbps per remote from audio.bytesSent", () => {
    const tl = synthTimeline({ seconds: 65, sendKbps: () => 800, recvKbps: () => 700 });
    // 32 kbps = 4000 bytes/s
    for (const s of tl) for (const p of s.peers) p.audio.bytesSent = ((s.t - tl[0]!.t) / 1000) * 4000;
    const r = summarizeTimeline(tl, 5).remotes[0]!;
    expect(r.audio_send_kbps).toBeCloseTo(32);
  });
});

describe("increase", () => {
  it("sums growth across a counter restart", () => {
    expect(increase([0, 100, 200, 10, 60])).toBe(260);
    expect(increase([5])).toBeNull();
  });
});
