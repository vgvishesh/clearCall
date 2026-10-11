import { describe, expect, it } from "vitest";
import type { LogEntry, QaStatsSample } from "../../web/src/core/types.ts";
import { parsePsTime, parseViewport, treeCpuSeconds } from "./peers.ts";
import { rampFor, worstRamp } from "./ramp.ts";

const JOIN = 1_000_000;
const sample = (
  s: number,
  h: number | undefined,
  kbps: number | undefined,
  id = "remoteAAAA",
): QaStatsSample =>
  ({
    t: JOIN + s * 1000,
    local: {},
    peers: [{ id, outboundKbps: kbps, video: { sentFrameHeight: h }, audio: {} }],
  }) as unknown as QaStatsSample;
const policy = (height: number, kbps: number, peer = "remote"): LogEntry => ({
  t: JOIN,
  level: "info",
  scope: "peer",
  msg: "policy applied",
  data: { peer, kind: "video", targetHeight: height, maxBitrate: kbps * 1000 },
});

describe("rampFor", () => {
  it("time to sustained target height and to 80 % of the cap, overshoot vs cap", () => {
    const tl = [
      sample(1, 180, 300),
      sample(2, 360, 700),
      sample(3, 720, 900), // one-sample blip: not sustained
      sample(4, 540, 1300),
      sample(5, 720, 1600),
      sample(6, 720, 1500),
      sample(7, 720, 1450),
    ];
    const [r] = rampFor(tl, [policy(720, 1500)], JOIN, 3);
    expect(r!.target_height).toBe(720);
    expect(r!.start_height).toBe(180);
    expect(r!.time_to_target_s).toBe(5);
    expect(r!.time_to_kbps_s).toBe(4); // 1300 ≥ 1200 from t=4 on
    expect(r!.overshoot_pct).toBeCloseTo(6.7, 1);
  });

  it("never reaching the target → null, and worstRamp propagates null", () => {
    const tl = [sample(1, 180, 200), sample(2, 360, 400)];
    const rs = rampFor(tl, [policy(720, 1500)], JOIN);
    expect(rs[0]!.time_to_target_s).toBeNull();
    expect(worstRamp(rs).time_to_target_s).toBeNull();
  });

  it("without a policy log the target falls back to the highest height seen", () => {
    const tl = [sample(1, 180, 200), sample(2, 360, 400), sample(3, 360, 400), sample(4, 360, 400)];
    const [r] = rampFor(tl, [], JOIN);
    expect(r!.target_height).toBe(360);
    expect(r!.cap_kbps).toBeNull();
    expect(r!.time_to_target_s).toBe(2);
  });
});

describe("process-tree CPU", () => {
  it("parses ps time formats", () => {
    expect(parsePsTime("0:01.50")).toBeCloseTo(1.5);
    expect(parsePsTime("75:00.00")).toBe(4500);
    expect(parsePsTime("1:00:00")).toBe(3600);
    expect(parsePsTime("2-00:00:01")).toBe(172801);
  });
  it("sums a root and all its descendants only", () => {
    const ps = [
      "  10     1   0:01.00",
      "  11    10   0:02.00",
      "  12    11   0:03.00",
      "  20     1   9:00.00",
    ].join("\n");
    expect(treeCpuSeconds(ps, [10])).toBeCloseTo(6);
  });
});

describe("parseViewport", () => {
  it("parses WxH[@dpr]", () => {
    expect(parseViewport("390x844@3")).toEqual({ width: 390, height: 844, deviceScaleFactor: 3 });
    expect(parseViewport("960x600")).toEqual({ width: 960, height: 600, deviceScaleFactor: 1 });
    expect(parseViewport("phone")).toBeUndefined();
    expect(parseViewport(undefined)).toBeUndefined();
  });
});
