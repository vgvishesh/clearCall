import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate, gatesFor, loadThresholds, parseThresholds, splitKey } from "./thresholds.ts";

const YAML = `
defaults:
  freeze_ratio_max: 0.01
  time_to_first_frame_ms_max: 1500
profiles:
  good_wifi: { vmaf_min: 85, kbps_max: 1500 }
  3g_lossy:  { vmaf_min: 60, freeze_ratio_max: 0.03 }
  music_mode: { music_mode_better_than_voice: true }
`;

describe("thresholds", () => {
  const t = parseThresholds(YAML, "proposed");

  it("loads the shipped proposed file when thresholds.yaml is absent", () => {
    const real = loadThresholds();
    expect(["adopted", "proposed"]).toContain(real.source);
    expect(Object.keys(real.profiles)).toContain("good_wifi");
  });

  it("prefers thresholds.yaml over the proposed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "thr-"));
    writeFileSync(join(dir, "thresholds.proposed.yaml"), YAML);
    expect(loadThresholds(dir).source).toBe("proposed");
    writeFileSync(join(dir, "thresholds.yaml"), "profiles:\n  good_wifi: { vmaf_min: 90 }\n");
    const a = loadThresholds(dir);
    expect(a.source).toBe("adopted");
    expect(a.profiles.good_wifi).toEqual({ vmaf_min: 90 });
  });

  it("profile keys override defaults", () => {
    expect(gatesFor(t, "3g_lossy")).toEqual({
      freeze_ratio_max: 0.03,
      time_to_first_frame_ms_max: 1500,
      vmaf_min: 60,
    });
    expect(gatesFor(t, "unknown")).toEqual(t.defaults);
  });

  it("splits keys into metric + operator", () => {
    expect(splitKey("vmaf_min")).toEqual({ metric: "vmaf", op: ">=" });
    expect(splitKey("kbps_max")).toEqual({ metric: "kbps", op: "<=" });
    expect(splitKey("music_mode_better_than_voice")).toEqual({
      metric: "music_mode_better_than_voice",
      op: "==",
    });
  });

  it("passes, fails at the boundary correctly", () => {
    const ok = evaluate(t, "good_wifi", {
      vmaf: 85,
      kbps: 1500,
      freeze_ratio: 0.01,
      time_to_first_frame_ms: 900,
    });
    expect(ok.breached).toBe(false);
    expect(ok.rows.every((r) => r.status === "pass")).toBe(true);
    const bad = evaluate(t, "good_wifi", {
      vmaf: 84.9,
      kbps: 1501,
      freeze_ratio: 0,
      time_to_first_frame_ms: 900,
    });
    expect(bad.breached).toBe(true);
    expect(bad.rows.filter((r) => r.status === "fail").map((r) => r.key)).toEqual(["vmaf_min", "kbps_max"]);
  });

  it("not-measured is listed but not a breach; scorer errors are a breach", () => {
    const e = evaluate(t, "good_wifi", { vmaf: 90, kbps: 100 });
    expect(e.breached).toBe(false);
    expect(e.rows.find((r) => r.key === "freeze_ratio_max")?.status).toBe("not-measured");
    const err = evaluate(t, "good_wifi", { kbps: 100 }, { vmaf: "no readable frame ids" });
    expect(err.breached).toBe(true);
    expect(err.rows.find((r) => r.key === "vmaf_min")).toMatchObject({
      status: "error",
      note: "no readable frame ids",
    });
    expect(evaluate(t, "good_wifi", { vmaf: Number.NaN }).rows[2]?.status).toBe("not-measured");
  });

  it("boolean gates", () => {
    expect(evaluate(t, "music_mode", { music_mode_better_than_voice: true }).breached).toBe(false);
    expect(evaluate(t, "music_mode", { music_mode_better_than_voice: false }).breached).toBe(true);
  });

  it("rejects malformed files", () => {
    expect(() => parseThresholds("defaults: { a: nope }", "proposed")).toThrow(/defaults/);
    expect(() => parseThresholds("profiles: { x: 3 }", "proposed")).toThrow(/profiles.x/);
  });
});
