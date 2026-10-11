import { describe, expect, it } from "vitest";
import { synthTimeline } from "./fixtures.ts";
import { buildMetrics, errMsg } from "./lab.ts";
import { summarizeTimeline } from "./metrics.ts";
import { loadProfile } from "./profiles.ts";
import type { DirectionResult } from "./report.ts";
import type { VmafResult } from "./video.ts";

const vmaf = (mean: number): VmafResult => ({
  vmaf_mean: mean,
  vmaf_p5: mean - 5,
  vmaf_min: mean - 10,
  psnr_y: 40,
  ssim: 0.98,
  frames_scored: 100,
  alignment: { unreadable: 0, repeats: 0, skipped: 0, outOfRange: 0, aligned: 100, delivery_ratio: 1 },
});
const t0 = 1_700_000_000_000;

describe("buildMetrics", () => {
  it("takes the worst direction and the worst participant", () => {
    const p = loadProfile("good_wifi");
    const dirs: DirectionResult[] = [
      {
        from: "p1",
        to: "p0",
        mode: "voice",
        video: vmaf(90),
        speech: { pesq_wb: 4.3, pesq_wb_min: 4.2, segments: 5, delay_ms: 0, corr: 0.9 },
      },
      {
        from: "p0",
        to: "p1",
        mode: "voice",
        video: vmaf(84),
        speech: { error: "uv failed" },
        dnsmos: { sig: 3.5, bak: 4, ovrl: 3.3, windows: 9 },
      },
    ];
    const peers = [
      {
        label: "p0",
        connected_ms: 700,
        first_frame_ms: 900,
        cpu_pct: 30,
        summary: summarizeTimeline(synthTimeline({ t0, seconds: 30, sendKbps: () => 900 })),
      },
      {
        label: "p1",
        connected_ms: 800,
        first_frame_ms: 1100,
        cpu_pct: 45,
        summary: summarizeTimeline(synthTimeline({ t0, seconds: 30, sendKbps: () => 1200 })),
      },
    ];
    const { metrics, errors } = buildMetrics(p, { peers, directions: dirs, t0, timelines: {} });
    expect(metrics).toMatchObject({
      vmaf: 84,
      vmaf_p5: 79,
      pesq_wb: 4.3,
      dnsmos_ovrl: 3.3,
      kbps: 2200,
      time_to_first_frame_ms: 1100,
      setup_success_rate: 1,
      cpu_pct: 45,
    });
    expect(errors).toEqual({});
  });

  it("records scorer errors when every attempt failed, and partial setup", () => {
    const p = loadProfile("group_10");
    const dirs: DirectionResult[] = [
      { from: "p1", to: "p0", mode: "voice", video: { error: "no readable frame ids" } },
    ];
    const peers = [
      { label: "p0", connected_ms: 1, first_frame_ms: null, cpu_pct: null, summary: summarizeTimeline([]) },
    ];
    const { metrics, errors } = buildMetrics(p, { peers, directions: dirs, t0, timelines: {} });
    expect(errors.vmaf).toBe("no readable frame ids");
    expect(errors.vmaf_thumbnail).toBe("no readable frame ids");
    expect(metrics.setup_success_rate).toBeCloseTo(0.1);
  });

  it("measures adaptation on bw_squeeze from p0's timeline", () => {
    const p = loadProfile("bw_squeeze");
    const tl = synthTimeline({
      t0,
      seconds: 90,
      sendKbps: (t) => (t < 30 ? 1900 : t < 32 ? 1000 : t < 60 ? 270 : t < 65 ? 500 : 1800),
    });
    const { metrics } = buildMetrics(p, { peers: [], directions: [], t0, timelines: { p0: tl } });
    expect(metrics.adapt_down_s).toBe(2);
    expect(metrics.recover_up_s).toBe(5);
  });
});

describe("errMsg", () => {
  it("keeps the first two meaningful lines of Playwright errors", () => {
    const e = new Error(
      "locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('[data-testid=\"start-call\"]')",
    );
    expect(errMsg(e)).toBe(
      "locator.click: Timeout 30000ms exceeded. — - waiting for locator('[data-testid=\"start-call\"]')",
    );
    expect(errMsg("x")).toBe("x");
  });
});
