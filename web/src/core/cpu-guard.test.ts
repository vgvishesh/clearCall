import { describe, expect, it } from "vitest";
import {
  type CpuAction,
  CpuGuard,
  type CpuSample,
  MAX_RETRIES,
  overloaded,
  RECOVER_MS,
} from "./cpu-guard.ts";

const ok = (t: number, extra: Partial<CpuSample> = {}): CpuSample => ({
  t,
  encodeMs: 4,
  sentFps: 29,
  cpuLimited: false,
  heavyCodec: false,
  hidden: false,
  ...extra,
});
// Lab numbers (ADR-0010): AV1 720p on a 1-core peer = 33 ms/frame at 20 fps.
const starved = (t: number, extra: Partial<CpuSample> = {}) => ok(t, { encodeMs: 33, sentFps: 20, ...extra });
// Reduced level, healthy device with headroom (1-core lab peer at 360p15: ~2.3 ms/frame).
const calm = (t: number) => ok(t, { encodeMs: 2, sentFps: 15 });
// VP8 on a 0.5-core peer: 149 ms/frame at 9 fps — overloaded even at the reduced level.
const crushed = (t: number, extra: Partial<CpuSample> = {}) => ok(t, { encodeMs: 149, sentFps: 9, ...extra });

function feed(g: CpuGuard, from: number, n: number, mk: (t: number) => CpuSample): CpuAction[] {
  const out: CpuAction[] = [];
  for (let i = 0; i < n; i++) {
    const a = g.update(mk(from + i * 1000));
    if (a) out.push(a);
  }
  return out;
}

describe("overloaded()", () => {
  it("separates the lab cases", () => {
    expect(overloaded(starved(0), undefined, 0)).toBe(true); // AV1 @ 1 core
    expect(overloaded(ok(0, { encodeMs: 18.9, sentFps: 27.5 }), undefined, 0)).toBe(false); // AV1 unconstrained
    expect(overloaded(ok(0, { encodeMs: 4.1, sentFps: 27 }), undefined, 0)).toBe(false); // VP8 @ 1 core
    expect(overloaded(ok(0, { encodeMs: 149, sentFps: 9 }), undefined, 0)).toBe(true); // VP8 @ 0.5 core
    expect(overloaded(ok(0, { cpuLimited: true }), undefined, 0)).toBe(true);
    expect(overloaded(ok(3000), 0, 0)).toBe(true); // sampler 3 s late: main thread starved
    expect(overloaded(ok(0, { encodeMs: undefined, sentFps: undefined }), undefined, 0)).toBe(false);
  });

  it("judges against the reduced level's 15 fps target (0.5-core lab buckets)", () => {
    expect(overloaded(ok(0, { encodeMs: 30, sentFps: 14 }), undefined, 1)).toBe(false);
    expect(overloaded(ok(0, { encodeMs: 31, sentFps: 8.4 }), undefined, 1)).toBe(true); // 36 % concealment
    expect(overloaded(ok(0, { encodeMs: 8, sentFps: 13.3 }), undefined, 1)).toBe(false); // 0 % concealment
  });

  it("a slow camera is not overload", () => {
    expect(overloaded(ok(0, { encodeMs: 15, sentFps: 15, sourceFps: 15 }), undefined, 0)).toBe(false);
    expect(overloaded(ok(0, { encodeMs: 15, sentFps: 15, sourceFps: 30 }), undefined, 0)).toBe(true);
  });

  it("a starved capture doesn't hide a starved encoder (0.5-core lab: camera 9 fps, sent 8 fps, 90 ms/frame)", () => {
    expect(overloaded(ok(0, { encodeMs: 90, sentFps: 8, sourceFps: 9 }), undefined, 0)).toBe(true);
    expect(overloaded(ok(0, { encodeMs: 18.9, sentFps: 27.5, sourceFps: 30 }), undefined, 0)).toBe(false);
  });
});

describe("CpuGuard", () => {
  it("never acts on a healthy device", () => {
    expect(feed(new CpuGuard(), 0, 300, ok)).toEqual([]);
  });

  it("first step drops the heavy codec AND reduces (one transition), then pauses", () => {
    const g = new CpuGuard();
    const a = feed(g, 0, 60, (t) => crushed(t, { heavyCodec: t < 15_000 }));
    expect(a).toEqual([
      { level: 1, reason: "overload", codecFallback: true },
      { level: 2, reason: "overload" },
    ]);
    expect(g.level).toBe(2);
    expect(g.codecFallback).toBe(true);
  });

  it("stays reduced when reducing was enough", () => {
    const g = new CpuGuard({ codecFallback: true });
    feed(g, 0, 10, starved);
    expect(g.level).toBe(1);
    // At 15 fps the same device encodes 33 ms/frame at 15 fps: within budget, no pause.
    expect(feed(g, 10_000, 40, (t) => ok(t, { encodeMs: 33, sentFps: 15 }))).toEqual([]);
  });

  it("needs a sustained overload (6 of 10), not a blip", () => {
    const g = new CpuGuard();
    expect(feed(g, 0, 120, (t) => (t % 4000 === 0 ? starved(t) : ok(t)))).toEqual([]);
  });

  it("a constrained device (codecs already excluded) just reduces", () => {
    const g = new CpuGuard({ codecFallback: true });
    expect(feed(g, 0, 10, (t) => starved(t, { heavyCodec: true }))[0]).toEqual({
      level: 1,
      reason: "overload",
    });
  });

  it("recovers after a calm minute, backs off when that was wrong, then keeps the level", () => {
    const g = new CpuGuard({ codecFallback: true });
    // Calm at 360p15 with headroom: 2 ms/frame (×4 for 720p ≈ 8 ms, well inside 40 % of 33 ms).
    const ok = (t: number) => calm(t);
    let t = 0;
    feed(g, t, 10, starved); // → reduced at 9 s
    t = 10_000;
    expect(g.level).toBe(1);
    expect(feed(g, t, RECOVER_MS / 1000 - 5, ok)).toEqual([]); // not yet
    t += (RECOVER_MS / 1000 - 5) * 1000;
    expect(feed(g, t, 10, ok)).toEqual([{ level: 0, reason: "recovered" }]);
    t += 10_000;
    let wait = RECOVER_MS;
    for (let i = 1; i <= MAX_RETRIES + 1; i++) {
      feed(g, t, 10, starved); // overloaded again right after recovering → reduced, longer wait
      t += 10_000;
      expect(g.level).toBe(1);
      wait *= 2;
      const calm = feed(g, t, wait / 1000 + 10, ok);
      t += (wait / 1000 + 10) * 1000;
      if (i <= MAX_RETRIES) expect(calm).toEqual([{ level: 0, reason: "recovered" }]);
      else expect(calm).toEqual([]); // kept for the rest of the call
    }
  });

  it("no recovery to 720p30 without encode headroom (0.5-core lab peer: 3.5–5 ms/frame at 360p15)", () => {
    const g = new CpuGuard({ codecFallback: true });
    feed(g, 0, 10, starved);
    expect(g.level).toBe(1);
    expect(feed(g, 10_000, 300, (t) => ok(t, { encodeMs: 4.5, sentFps: 14.5 }))).toEqual([]);
    expect(g.level).toBe(1);
  });

  it("ignores a hidden tab (throttled timers are not starvation)", () => {
    const g = new CpuGuard();
    expect(feed(g, 0, 30, (t) => ok(t * 5, { hidden: true }))).toEqual([]);
    expect(g.level).toBe(0);
  });

  it("main-thread starvation alone (sampler gaps) escalates even with video paused", () => {
    const g = new CpuGuard({ codecFallback: true });
    const a = feed(g, 0, 40, (t) => ok(t * 3, { encodeMs: undefined, sentFps: undefined }));
    expect(a.map((x) => x.level)).toEqual([1, 2]);
  });
});
