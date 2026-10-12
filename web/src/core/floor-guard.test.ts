import { describe, expect, it } from "vitest";
import { FloorGuard, type GuardSample } from "./floor-guard.ts";

const FLOOR = 200_000;
const s = (t: number, o: Partial<GuardSample> = {}): GuardSample => ({
  t: t * 1000,
  floorBps: FLOOR,
  estimateBps: FLOOR,
  rttMs: 400,
  lossFraction: 0.05,
  videoSendBps: 150_000,
  ...o,
});

describe("FloorGuard", () => {
  it("idle without a floor", () => {
    const g = new FloorGuard();
    for (let t = 0; t < 20; t++) expect(g.update(s(t, { floorBps: null, rttMs: 3000 }))).toBeUndefined();
  });

  it("ignores random loss and in-order jitter at the floor (3g_lossy-like samples)", () => {
    const g = new FloorGuard();
    const rtts = [330, 410, 520, 380, 450, 360, 590, 400, 470, 350];
    const loss = [0, 0.05, 0.12, 0, 0.25, 0, 0.07, 0.03, 0, 0.1];
    for (let t = 0; t < 120; t++)
      expect(g.update(s(t, { rttMs: rtts[t % 10], lossFraction: loss[t % 10] }))).toBeUndefined();
  });

  it("caps the encoder on a standing queue at the floor, cuts again only after a drain time, then recovers", () => {
    const g = new FloorGuard();
    for (let t = 0; t < 10; t++) g.update(s(t, { rttMs: 320 }));
    // link slower than the floor: RTT climbs well above the 30 s minimum
    expect(g.update(s(10, { rttMs: 900 }))).toBeUndefined();
    expect(g.update(s(12, { rttMs: 1000 }))).toBeUndefined();
    expect(g.update(s(13, { rttMs: 1100 }))).toBe(90_000); // 0.6 × 150 kbps after a 3 s hold
    // RTT stays high while the queue drains: no second cut before 6 s
    expect(g.update(s(16, { rttMs: 1200, videoSendBps: 90_000 }))).toBe(90_000);
    expect(g.update(s(18, { rttMs: 1200, videoSendBps: 90_000 }))).toBe(90_000);
    expect(g.update(s(19, { rttMs: 1200, videoSendBps: 90_000 }))).toBe(54_000);
    // queue drained
    expect(g.update(s(20, { rttMs: 400, videoSendBps: 54_000 }))).toBe(54_000);
    expect(g.update(s(21, { rttMs: 380 }))).toBe(67_500); // ×1.25 every 2 s
    let cap = g.cap;
    let t = 23;
    for (; t < 100 && cap !== undefined; t += 2) cap = g.update(s(t, { rttMs: 350 }));
    expect(cap).toBeUndefined(); // released when the cap reaches the floor
    expect(t).toBeLessThan(40);
  });

  it("heavy sustained loss counts as trouble; never below the minimum cap", () => {
    const g = new FloorGuard();
    let cap: number | undefined;
    for (let t = 0; t < 40; t++) cap = g.update(s(t, { lossFraction: 0.4, videoSendBps: 60_000 }));
    expect(cap).toBe(50_000);
  });

  it("not floor-bound (GCC above the floor) → GCC handles congestion, guard idle", () => {
    const g = new FloorGuard();
    for (let t = 0; t < 10; t++) g.update(s(t, { rttMs: 50, estimateBps: 1_500_000 }));
    for (let t = 10; t < 30; t++)
      expect(g.update(s(t, { rttMs: 900, estimateBps: 1_400_000 }))).toBeUndefined();
  });

  it("an active cap is released once it climbs back to the floor", () => {
    const g = new FloorGuard();
    for (let t = 0; t < 5; t++) g.update(s(t, { rttMs: 300 }));
    for (let t = 5; t < 9; t++) g.update(s(t, { rttMs: 1000 }));
    expect(g.cap).toBe(90_000);
    let cap = g.cap;
    for (let t = 10; t < 80 && cap !== undefined; t += 2)
      cap = g.update(s(t, { rttMs: 300, estimateBps: 600_000 }));
    expect(cap).toBeUndefined();
  });
});
