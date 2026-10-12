import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEVEL_TUNING as K,
  type LevelChange,
  LevelController,
  type PairSample,
  SenderLevels,
} from "./adaptive.ts";

const AUDIO = 32_000;
/** Clean good link as Chromium reports it at the 600 kbps cap (unshaped lab: estimate frozen at 1.2–1.5 Mbps). */
const good = (t: number, o: Partial<PairSample> = {}): PairSample => ({
  t,
  eligible: true,
  estimateBps: 1_400_000,
  limitation: "bandwidth", // self-inflicted at the 600 cap: the encoder settles at 270p
  lossFraction: 0,
  audioBps: AUDIO,
  ...o,
});

/** Feed `n` 1 Hz samples starting at `t0`; returns every change with the time it happened. */
function run(
  c: LevelController,
  t0: number,
  n: number,
  f: (t: number) => PairSample,
): { t: number; ch: LevelChange }[] {
  const out: { t: number; ch: LevelChange }[] = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + i * 1000;
    const ch = c.update(f(t));
    if (ch) out.push({ t, ch });
  }
  return out;
}

/** Controller already at high since t=10 s (good link upgrade). */
function highAt10s(): LevelController {
  const c = new LevelController();
  const ch = run(c, 0, 11, good);
  expect(ch).toEqual([{ t: 10_000, ch: { level: "high", reason: "headroom" } }]);
  return c;
}

describe("LevelController", () => {
  it("starts at base", () => {
    expect(new LevelController().level).toBe("base");
  });

  it("good link: upgrades after the 10 s hold, not before", () => {
    const c = new LevelController();
    expect(run(c, 0, 10, good)).toEqual([]); // t = 0..9 s
    expect(c.update(good(10_000))).toEqual({ level: "high", reason: "headroom" });
    // and stays there on a good link (no trouble at 800 kbps: limitation none)
    expect(run(c, 11_000, 300, (t) => good(t, { limitation: "none" }))).toEqual([]);
    expect(c.level).toBe("high");
  });

  it("a single bad sample restarts the upgrade hold", () => {
    const c = new LevelController();
    run(c, 0, 8, good);
    c.update(good(8_000, { estimateBps: 700_000 })); // below 1.1 × 832k, above the probe floor
    expect(run(c, 9_000, 10, good)).toEqual([]); // 9..18 s: hold restarted at 9 s
    expect(c.update(good(19_000))?.level).toBe("high");
  });

  it("squeeze: estimate drop downgrades within 3 s", () => {
    const c = highAt10s();
    run(c, 11_000, 10, (t) => good(t, { limitation: "none" })); // past the grace period
    const ch = run(c, 21_000, 5, (t) => good(t, { limitation: "none", estimateBps: 500_000 }));
    expect(ch).toEqual([{ t: 23_000, ch: { level: "base", reason: "estimate-drop" } }]);
  });

  it("squeeze: bandwidth limitation with the estimate near the edge downgrades within 3 s", () => {
    const c = highAt10s();
    run(c, 11_000, 10, (t) => good(t, { limitation: "none" }));
    // 880k: still above the 832k need, below the 915k upgrade bar
    const ch = run(c, 21_000, 5, (t) => good(t, { limitation: "bandwidth", estimateBps: 880_000 }));
    expect(ch).toEqual([{ t: 23_000, ch: { level: "base", reason: "bandwidth-limited" } }]);
  });

  it("a sticky bandwidth limitation with plenty of estimate is not trouble (encoder state, not the network)", () => {
    const c = highAt10s();
    expect(run(c, 11_000, 120, (t) => good(t, { limitation: "bandwidth" }))).toEqual([]);
    expect(c.level).toBe("high");
  });

  it("loss ≥ 5 % downgrades within 3 s, even during the grace period", () => {
    const c = highAt10s();
    const ch = run(c, 11_000, 5, (t) => good(t, { limitation: "none", lossFraction: 0.08 }));
    expect(ch).toEqual([{ t: 13_000, ch: { level: "base", reason: "loss" } }]);
  });

  it("ignores bandwidth signals for the grace period right after an upgrade", () => {
    const c = highAt10s();
    // encoder still at 270p (limitation=bandwidth) and estimate climbing for 5 s: no downgrade
    expect(run(c, 11_000, 5, (t) => good(t, { estimateBps: 800_000 }))).toEqual([]);
    expect(c.level).toBe("high");
  });

  it("a hard estimate drop right after an upgrade (below what base needs) downgrades within 3 s", () => {
    const c = highAt10s();
    // squeezed 1 s after the upgrade (E2E case): 400 kbps can't even carry base
    const ch = run(c, 11_000, 5, (t) => good(t, { estimateBps: 400_000 }));
    expect(ch).toEqual([{ t: 13_000, ch: { level: "base", reason: "estimate-drop" } }]);
  });

  it("cpu-limited: never upgrades, even with plenty of bandwidth", () => {
    const c = new LevelController();
    expect(run(c, 0, 120, (t) => good(t, { limitation: "cpu", cpuLimited: true }))).toEqual([]);
    expect(c.level).toBe("base");
  });

  it("cpu: waits the cooldown after the last cpu-limited sample before upgrading", () => {
    const c = new LevelController();
    run(c, 0, 5, (t) => good(t, { limitation: "cpu", cpuLimited: true }));
    const ch = run(c, 5_000, 40, good); // 5..44 s
    // last cpu at 4 s → clean from 34 s → upgrade at 44 s
    expect(ch).toEqual([{ t: 44_000, ch: { level: "high", reason: "headroom" } }]);
  });

  it("cpu while high downgrades within 3 s", () => {
    const c = highAt10s();
    const ch = run(c, 11_000, 5, (t) => good(t, { limitation: "cpu", cpuLimited: true }));
    expect(ch).toEqual([{ t: 13_000, ch: { level: "base", reason: "cpu" } }]);
  });

  it("no estimate (browser without availableOutgoingBitrate): stays at base", () => {
    const c = new LevelController();
    expect(run(c, 0, 300, (t) => good(t, { estimateBps: undefined }))).toEqual([]);
  });

  it("probe: an estimate held down near base usage still gets a trial after 15 s", () => {
    const c = new LevelController();
    // 760 kbps: under the 915k headroom bar, above the 1.15 × 632k = 727k probe floor
    const ch = run(c, 0, 20, (t) => good(t, { estimateBps: 760_000 }));
    expect(ch).toEqual([{ t: 15_000, ch: { level: "high", reason: "probe" } }]);
  });

  it("no probe when the estimate is at or below what base already sends", () => {
    const c = new LevelController();
    expect(run(c, 0, 120, (t) => good(t, { estimateBps: 640_000 }))).toEqual([]);
  });

  it("no flapping: noisy estimate around the bar never changes the level", () => {
    const c = new LevelController();
    // alternating just-above / just-below the headroom bar, under the probe floor every other second
    const ch = run(c, 0, 300, (t) => good(t, { estimateBps: (t / 1000) % 2 ? 950_000 : 700_000 }));
    expect(ch).toEqual([]);
  });

  it("no flapping: a single trouble sample in high doesn't downgrade", () => {
    const c = highAt10s();
    run(c, 11_000, 10, (t) => good(t, { limitation: "none" }));
    const ch = run(c, 21_000, 60, (t) =>
      good(t, { limitation: (t / 1000) % 3 === 0 ? "bandwidth" : "none" }),
    );
    expect(ch).toEqual([]);
  });

  it("repeated failed trials back off exponentially (20 s, 40 s, 80 s …) and cap at 160 s", () => {
    const c = new LevelController();
    // A link that looks fine at 600 but can't carry 800: every high period hits bandwidth limitation.
    let level = c.level;
    const ups: number[] = [];
    for (let i = 0; i < 900; i++) {
      const t = i * 1000;
      const s = level === "high" ? good(t, { limitation: "bandwidth", estimateBps: 700_000 }) : good(t);
      const ch = c.update(s);
      if (ch) {
        level = ch.level;
        if (ch.level === "high") ups.push(t / 1000);
      }
    }
    // up at 10 s; 9 s in high (6 s grace + 3 s) → down at 18 → waits 20 s → up at 38 → down 46 → 40 s → 86 …
    expect(ups.slice(0, 5)).toEqual([10, 38, 86, 174, 342]);
    const gaps = ups.slice(1).map((u, i) => u - ups[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(160 + 8 + 1);
    expect(ups.length).toBeLessThan(10); // ≤ 1 trial every ~2.8 min once backed off
  });

  it("a high period that lasted stableMs resets the backoff", () => {
    const c = highAt10s();
    run(c, 11_000, K.stableMs / 1000, (t) => good(t, { limitation: "none" }));
    const t1 = 11_000 + K.stableMs;
    const down = run(c, t1, 3, (t) => good(t, { limitation: "none", estimateBps: 500_000 }));
    expect(down[0]?.ch.level).toBe("base");
    const tDown = down[0]!.t;
    const up = run(c, tDown + 1000, 40, good);
    expect(up[0]!.t - tDown).toBe(K.backoffMs);
  });

  it("ineligible (tier or small tile) goes back to base at once and restarts the hold", () => {
    const c = highAt10s();
    expect(c.update(good(11_000, { eligible: false }))).toEqual({ level: "base", reason: "ineligible" });
    expect(run(c, 12_000, 10, good)).toEqual([]);
    expect(c.update(good(22_000))?.level).toBe("high");
  });
});

describe("SenderLevels (per-sender coordination)", () => {
  const tick = (s: SenderLevels, f: (id: string) => PairSample) =>
    s.update(new Map(["a", "b", "c"].map((id) => [id, f(id)])));

  it("staggers upgrades: one pair per 5 s on a good link", () => {
    const s = new SenderLevels();
    const ups: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      const t = i * 1000;
      for (const [id, ch] of tick(s, () => good(t))) if (ch.level === "high") ups[id] = t / 1000;
    }
    expect(ups).toEqual({ a: 10, b: 15, c: 20 });
  });

  it("cpu on one pair holds every pair at base", () => {
    const s = new SenderLevels();
    for (let i = 0; i < 60; i++) {
      const t = i * 1000;
      const ch = tick(s, (id) => good(t, id === "b" ? { limitation: "cpu" } : {}));
      expect(ch.size).toBe(0);
    }
    expect(["a", "b", "c"].map((id) => s.level(id))).toEqual(["base", "base", "base"]);
  });

  it("cpu on one pair downgrades every high pair together (not staggered)", () => {
    const s = new SenderLevels();
    for (let i = 0; i < 40; i++) tick(s, () => good(i * 1000, { limitation: "none" }));
    expect(["a", "b", "c"].map((id) => s.level(id))).toEqual(["high", "high", "high"]);
    let downs = new Map<string, LevelChange>();
    for (let i = 40; i < 43; i++) {
      const t = i * 1000;
      const ch = tick(s, (id) => good(t, { limitation: id === "c" ? "cpu" : "none" }));
      if (ch.size) downs = ch;
    }
    expect([...downs.values()].map((c) => c.reason)).toEqual(["cpu", "cpu", "cpu"]);
  });

  it("a receiver with a poor link only lowers its own pair", () => {
    const s = new SenderLevels();
    for (let i = 0; i < 40; i++) {
      const t = i * 1000;
      tick(s, (id) => good(t, id === "c" ? { estimateBps: 500_000 } : { limitation: "none" }));
    }
    expect(["a", "b", "c"].map((id) => s.level(id))).toEqual(["high", "high", "base"]);
  });

  it("forgets pairs that disappear or are reset (a rebuilt pair starts at base)", () => {
    const s = new SenderLevels();
    for (let i = 0; i < 40; i++) tick(s, () => good(i * 1000, { limitation: "none" }));
    s.reset("a");
    expect(s.level("a")).toBe("base");
    s.update(new Map([["b", good(41_000, { limitation: "none" })]]));
    expect(s.level("c")).toBe("base");
  });
});
