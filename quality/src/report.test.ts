import { describe, expect, it } from "vitest";
import { synthTimeline } from "./fixtures.ts";
import { summarizeTimeline } from "./metrics.ts";
import { diffMetric, diffReports, type LabReport, renderDiff, renderMarkdown } from "./report.ts";
import type { MetricValue } from "./thresholds.ts";

const net = (shaping: "netem" | "unshaped" = "netem") => ({
  shaping,
  link: {
    up_kbps: 3000,
    down_kbps: 10000,
    delay_ms: 50,
    jitter_ms: 15,
    loss_pct: 1,
    loss_model: "random" as const,
  },
  schedule: [],
});
const rep = (
  metrics: Record<string, MetricValue>,
  profile = "4g_typical",
  shaping: "netem" | "unshaped" = "netem",
) => ({
  metrics,
  profile,
  network: net(shaping),
});

describe("diffMetric", () => {
  it("respects direction and noise bands", () => {
    expect(diffMetric("vmaf", 80, 80.9).verdict).toBe("same");
    expect(diffMetric("vmaf", 80, 81.5).verdict).toBe("better");
    expect(diffMetric("pesq_wb", 4.0, 3.9).verdict).toBe("worse");
    expect(diffMetric("kbps", 1000, 1020).verdict).toBe("same"); // ±3 % relative
    expect(diffMetric("kbps", 1000, 900).verdict).toBe("better");
    expect(diffMetric("freeze_ratio", 0.01, 0.02).verdict).toBe("worse");
    expect(diffMetric("vmaf", null, 80).verdict).toBe("n/a");
    expect(diffMetric("unknown_metric", 1, 2).verdict).toBe("n/a");
    expect(diffMetric("vmaf", 80, 82).delta).toBe(2);
  });
});

describe("diffReports overall verdict", () => {
  const cases: [Record<string, number>, Record<string, number>, string][] = [
    [{ vmaf: 80, pesq_wb: 4, kbps: 1000 }, { vmaf: 83, pesq_wb: 4, kbps: 1000 }, "win"], // better quality, same bw
    [{ vmaf: 80, pesq_wb: 4, kbps: 1000 }, { vmaf: 80.5, pesq_wb: 4.02, kbps: 800 }, "win"], // same quality, less bw
    [{ vmaf: 80, kbps: 1000 }, { vmaf: 83, kbps: 1300 }, "trade-off"], // better quality, more bw
    [{ vmaf: 80, kbps: 1000 }, { vmaf: 77, kbps: 1000 }, "loss"],
    [{ vmaf: 80, kbps: 1000 }, { vmaf: 80, kbps: 1200 }, "loss"], // same quality, more bw
    [{ vmaf: 80, kbps: 1000 }, { vmaf: 77, kbps: 700 }, "trade-off"],
    [{ vmaf: 80, kbps: 1000 }, { vmaf: 80.2, kbps: 1010 }, "no-change"],
    [{ cpu_pct: 1 }, { cpu_pct: 2 }, "incomparable"],
  ];
  for (const [a, b, want] of cases)
    it(`${JSON.stringify(a)} → ${JSON.stringify(b)} = ${want}`, () =>
      expect(diffReports(rep(a), rep(b)).overall).toBe(want));

  it("warns when profiles or shaping differ", () => {
    const d = diffReports(rep({ vmaf: 80 }, "good_wifi", "unshaped"), rep({ vmaf: 85 }, "3g_lossy"));
    expect(d.warnings.join(" ")).toMatch(/different profiles/);
    expect(d.warnings.join(" ")).toMatch(/different shaping/);
  });

  it("renders a table", () => {
    const md = renderDiff(diffReports(rep({ vmaf: 80, kbps: 1000 }), rep({ vmaf: 83, kbps: 990 })), "a", "b");
    expect(md).toContain("Overall: **win**");
    expect(md).toContain("| vmaf | 80 | 83 | +3 | better |");
  });
});

describe("renderMarkdown", () => {
  const base: LabReport = {
    schema: 1,
    profile: "good_wifi",
    started: "2026-10-11T10:00:00Z",
    finished: "2026-10-11T10:01:00Z",
    network: net("unshaped"),
    topology: "p2p",
    participants: 2,
    mode: "voice",
    corpus: { audio: "speech_noisy", video: "talking_head", synthetic: true },
    duration_s: 60,
    app_url: "http://localhost:8787",
    git: { commit: "abc1234", dirty: false },
    metrics: { vmaf: 90, kbps: 1200 },
    errors: { pesq_wb: "uv failed" },
    directions: [{ from: "p0", to: "p1", mode: "voice", speech: { error: "uv failed" } }],
    peers: [
      {
        label: "p0",
        connected_ms: 800,
        first_frame_ms: 900,
        cpu_pct: 40,
        summary: summarizeTimeline(synthTimeline({ seconds: 20 })),
      },
    ],
    evaluation: {
      source: "proposed",
      breached: true,
      rows: [
        { key: "vmaf_min", metric: "vmaf", op: ">=", limit: 85, value: 90, status: "pass" },
        {
          key: "pesq_wb_min",
          metric: "pesq_wb",
          op: ">=",
          limit: 4.2,
          value: undefined,
          status: "error",
          note: "uv failed",
        },
      ],
    },
    notes: ["note one"],
  };
  it("labels unshaped runs and proposed thresholds, shows errors", () => {
    const md = renderMarkdown(base);
    expect(md).toContain("# Quality lab — good_wifi (UNSHAPED)");
    expect(md).toContain("Unshaped run");
    expect(md).toContain("thresholds.proposed.yaml (proposed, not adopted by the owner)");
    expect(md).toContain("Verdict: **FAIL**");
    expect(md).toContain("**ERROR** uv failed");
    expect(md).toContain("error: uv failed");
    expect(md).toContain("note one");
  });
  it("omits the unshaped banner for netem runs", () => {
    const md = renderMarkdown({
      ...base,
      network: net("netem"),
      evaluation: { ...base.evaluation, source: "adopted" },
    });
    expect(md).not.toContain("UNSHAPED");
    expect(md).not.toContain("proposed, not adopted");
  });
});
