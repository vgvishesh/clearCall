import { describe, expect, it } from "vitest";
import { synthTimeline } from "./fixtures.ts";
import {
  adaptTimes,
  firstTime,
  mean,
  percentile,
  type QaStatsSample,
  sendLevelSummary,
  sendSeries,
  summarizeTimeline,
} from "./metrics.ts";

describe("sendLevelSummary (ADR-0008)", () => {
  const sample = (t: number, levels: Record<string, "base" | "high" | undefined>): QaStatsSample =>
    ({
      t,
      local: {},
      peers: Object.entries(levels).map(([id, sendLevel]) => ({
        id,
        name: "",
        connectionState: "connected",
        audio: {},
        video: sendLevel ? { sendLevel } : {},
      })),
    }) as QaStatsSample;

  it("ratio, late ratio, first upgrade and per-pair changes", () => {
    // p0: pair a goes high at 10 s and stays; pair b flaps base→high→base→high
    const p0 = Array.from({ length: 20 }, (_, i) =>
      sample(1000 + i * 1000, {
        a: i >= 9 ? "high" : "base",
        b: [5, 6, 7, 8, 9].includes(i) || i >= 15 ? "high" : "base",
      }),
    );
    const r = sendLevelSummary({ p0 }, 0);
    expect(r.first_high_s).toBe(6);
    expect(r.high_ratio).toBeCloseTo((11 + 10) / 40);
    expect(r.high_ratio_late).toBeCloseTo((10 + 5) / 20);
    expect(r.changes_max).toBe(3);
  });

  it("all null without levels (2-party / older builds)", () => {
    expect(sendLevelSummary({ p0: [sample(0, { a: undefined })] }, 0)).toEqual({
      high_ratio: null,
      high_ratio_late: null,
      first_high_s: null,
      changes_max: null,
    });
  });
});

describe("basic stats", () => {
  it("mean and nearest-rank percentile", () => {
    expect(mean([])).toBeNull();
    expect(mean([1, 2, 3])).toBe(2);
    expect(percentile([], 95)).toBeNull();
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile(xs, 100)).toBe(100);
    expect(percentile([5], 50)).toBe(5);
  });
});

describe("summarizeTimeline", () => {
  it("computes bandwidth, freeze and concealment ratios after the ramp-up skip", () => {
    const tl = synthTimeline({
      seconds: 65,
      sendKbps: (t) => (t < 5 ? 5000 : 800),
      recvKbps: () => 700,
      freezeS: (t) => (t >= 30 ? 0.6 : 0), // one 0.6 s freeze over 60 s → 1 %
      concealed: (t) => t * 480, // 1 % of 48 kHz
    });
    const s = summarizeTimeline(tl, 5);
    expect(s.samples).toBe(61);
    expect(s.duration_s).toBe(60);
    expect(s.send_kbps_mean).toBe(800); // ramp-up excluded
    expect(s.total_kbps_mean).toBe(1500);
    expect(s.freeze_ratio_max).toBeCloseTo(0.01);
    expect(s.concealment_ratio_max).toBeCloseTo(0.01);
    expect(s.remotes).toHaveLength(1);
    expect(s.remotes[0]).toMatchObject({
      id: "peerB",
      fps_mean: 30,
      candidate_type: "host",
      frames_decoded: 1800,
    });
    expect(s.remotes[0]?.quality_limitation).toEqual({ none: 61 });
  });

  it("takes the worst remote for ratios and sums per-peer kbps when local totals are missing", () => {
    const tl = synthTimeline({
      seconds: 20,
      peers: ["a", "b"],
      freezeS: (t, p) => (p === "b" ? t * 0.05 : 0),
    });
    for (const x of tl) x.local = {};
    const s = summarizeTimeline(tl, 0);
    expect(s.freeze_ratio_max).toBeCloseTo(0.05);
    expect(s.send_kbps_mean).toBeCloseTo(1000);
    expect(s.encode_ms_mean).toBeNull();
  });

  it("is robust to empty and single-sample timelines", () => {
    expect(summarizeTimeline([]).samples).toBe(0);
    const one = summarizeTimeline(synthTimeline({ seconds: 0 }), 0);
    expect(one.duration_s).toBe(0);
    expect(one.freeze_ratio_max).toBeNull();
  });
});

describe("adaptation and first-time helpers", () => {
  const t0 = 1_700_000_000_000;
  it("measures adapt-down and recover-up times", () => {
    const tl = synthTimeline({
      t0,
      seconds: 90,
      sendKbps: (t) => (t < 30 ? 1800 : t < 33 ? 900 : t < 60 ? 260 : t < 66 ? 600 : 1500),
    });
    const r = adaptTimes(sendSeries(tl, t0), 30, 60, 250);
    expect(r.baseline_kbps).toBe(1800);
    expect(r.adapt_down_s).toBe(3);
    expect(r.recover_up_s).toBe(6); // 1500 ≥ 0.7 × 1800
  });
  it("returns null when never adapting", () => {
    const tl = synthTimeline({ t0, seconds: 90, sendKbps: () => 1800 });
    expect(adaptTimes(sendSeries(tl, t0), 30, 60, 250)).toMatchObject({
      adapt_down_s: null,
      recover_up_s: 0,
    });
  });
  it("finds the first sample matching a predicate", () => {
    const tl = synthTimeline({ t0, seconds: 10, connection: (t) => (t < 4 ? "connecting" : "connected") });
    expect(firstTime(tl, t0, (s) => s.peers.every((p) => p.connectionState === "connected"))).toBe(4000);
    expect(firstTime(tl, t0, () => false)).toBeNull();
  });
});
