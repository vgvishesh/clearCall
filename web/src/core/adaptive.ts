/**
 * Adaptive send level for the 3–4 participant tier (ADR-0008). Pure state machines, driven by 1 Hz stats samples.
 *
 * The tier has two video settings: `base` (600 kbps cap; the encoder settles at ~270p) and `high` (800 kbps, 360p).
 * They differ ONLY in `maxBitrate`; the resolution follows from libwebrtc's own bitrate→resolution adaptation, so a
 * level change never adds a `scaleResolutionDownBy` change (Firefox's H264 sender stalls on those, codecs.ts).
 *
 * One controller per pair (each pair has its own encode and its own congestion controller, so a receiver with a poor
 * downlink only lowers its own stream); a per-sender coordinator (`SenderLevels`) adds what the pairs share:
 * - CPU: any pair reporting `qualityLimitationReason=cpu` holds every pair at base (one CPU encodes all streams);
 * - Uplink: upgrades are staggered (one pair at a time, `staggerMs` apart), so a shared uplink that can't carry
 *   (N−1)×800 kbps is detected after one extra stream instead of N−1.
 *
 * Upgrade: `upgradeHoldMs` of continuous headroom — pair estimate (`availableOutgoingBitrate`) ≥ `upgradeFactor` ×
 * (high video + audio), loss < `cleanLoss`, no CPU limitation within `cpuCooldownMs`.
 * Probe (the chicken-and-egg: a 600-capped sender's estimate is bounded by what it actually sends, so it may never
 * show 800 available): if the estimate is clean and ≥ `probeFloorFactor` × what base needs for `probeHoldMs`, try
 * high anyway; if it fails, the downgrade path backs off.
 * Downgrade (fast): `downgradeHoldMs` of continuous trouble while high — estimate < high need, outbound
 * `qualityLimitationReason=bandwidth` with the estimate near the edge (< the upgrade bar), loss ≥ `badLoss`, or CPU.
 * The limitation alone is not trusted: it is libwebrtc's quality-scaler state, which stays "bandwidth" at 270p long
 * after 800 kbps became available (lab, ADR-0008).
 * For `graceMs` after an upgrade the encoder and the estimate get a moment to climb: the limitation is ignored and only
 * an estimate that cannot even carry base (600 kbps + audio) counts (E2E squeeze right after an upgrade: 9 s → ~4 s).
 * Anti-flap: every downgrade doubles the wait before the next upgrade (`backoffMs` → `maxBackoffMs`); a high period
 * that lasts `stableMs` resets it.
 */

export type SendLevel = "base" | "high";

/** Stats sampler period the holds are counted in. */
const SAMPLE_MS = 1_000;

export interface LevelTuning {
  baseBps: number;
  highBps: number;
  upgradeFactor: number;
  probeFloorFactor: number;
  upgradeHoldMs: number;
  probeHoldMs: number;
  downgradeHoldMs: number;
  graceMs: number;
  cpuCooldownMs: number;
  backoffMs: number;
  maxBackoffMs: number;
  stableMs: number;
  staggerMs: number;
  cleanLoss: number;
  badLoss: number;
}

export const DEFAULT_LEVEL_TUNING: LevelTuning = {
  baseBps: 600_000,
  highBps: 800_000,
  upgradeFactor: 1.1,
  probeFloorFactor: 1.15,
  upgradeHoldMs: 10_000,
  probeHoldMs: 15_000,
  downgradeHoldMs: 3_000,
  graceMs: 6_000,
  cpuCooldownMs: 30_000,
  backoffMs: 20_000,
  maxBackoffMs: 160_000,
  stableMs: 120_000,
  staggerMs: 5_000,
  cleanLoss: 0.02,
  badLoss: 0.05,
};

/** One stats sample for one pair, as the controller sees it. */
export interface PairSample {
  /** ms */
  t: number;
  /** High would change this pair's encode cap (tier 3–4 and the receiver's tile wants ≥ 360p). */
  eligible: boolean;
  /** Selected candidate pair `availableOutgoingBitrate` (bps); undefined = browser doesn't expose it. */
  estimateBps?: number | undefined;
  /** Outbound video `qualityLimitationReason`. */
  limitation?: string | undefined;
  /** Receiver-reported loss of our video (remote-inbound-rtp fractionLost, 0..1). */
  lossFraction?: number | undefined;
  /** Our audio bitrate on this pair (bps). */
  audioBps: number;
  /** CPU-limited anywhere on this sender (coordinator fills this in). */
  cpuLimited?: boolean;
}

export type LevelReason =
  | "start"
  | "ineligible"
  | "headroom"
  | "probe"
  | "estimate-drop"
  | "bandwidth-limited"
  | "loss"
  | "cpu";

export interface LevelChange {
  level: SendLevel;
  reason: LevelReason;
}

/**
 * Estimate below `floor` = trouble. A missing estimate is trouble only outside the grace period (some engines
 * report the selected pair's estimate late after a renegotiation).
 */
function estimateTrouble(estimate: number | undefined, floor: number, inGrace: boolean): boolean {
  return estimate === undefined ? !inGrace : estimate < floor;
}

/** Per-pair level state machine. `update` returns a change, or null when the level stays. */
export class LevelController {
  private _level: SendLevel = "base";
  private goodSince: number | null = null;
  private probeSince: number | null = null;
  private badSince: number | null = null;
  private highSince = 0;
  private lastCpuAt = Number.NEGATIVE_INFINITY;
  private nextUpgradeAt = Number.NEGATIVE_INFINITY;
  /** Downgrades since the last high period that lasted `stableMs` (backoff exponent). */
  private failures = 0;
  private _lastReason: LevelReason = "start";

  constructor(private readonly k: LevelTuning = DEFAULT_LEVEL_TUNING) {}

  get level(): SendLevel {
    return this._level;
  }

  get lastReason(): LevelReason {
    return this._lastReason;
  }

  /** Would this sample upgrade the pair (ignoring the sender's stagger)? Exposed for the coordinator. */
  wantsUpgrade(s: PairSample): LevelReason | null {
    if (this._level === "high" || !s.eligible) return null;
    this.track(s);
    if (s.t < this.nextUpgradeAt) return null;
    const k = this.k;
    if (this.goodSince !== null && s.t - this.goodSince >= k.upgradeHoldMs) return "headroom";
    if (this.probeSince !== null && s.t - this.probeSince >= k.probeHoldMs) return "probe";
    return null;
  }

  /** Feed one sample. `allowUpgrade` = the coordinator's stagger permits an upgrade now. */
  update(s: PairSample, allowUpgrade = true): LevelChange | null {
    const k = this.k;
    if (s.cpuLimited) this.lastCpuAt = s.t;
    if (!s.eligible) {
      this.resetHolds();
      if (this._level === "high") return this.set("base", "ineligible", s.t);
      return null;
    }
    if (this._level === "base") {
      const why = this.wantsUpgrade(s);
      if (why && allowUpgrade) return this.set("high", why, s.t);
      return null;
    }
    // high: look for trouble
    const need = k.highBps + s.audioBps;
    const inGrace = s.t - this.highSince < k.graceMs;
    let trouble: LevelReason | null = null;
    if (s.cpuLimited) trouble = "cpu";
    else if ((s.lossFraction ?? 0) >= k.badLoss) trouble = "loss";
    else if (!inGrace && s.limitation === "bandwidth" && (s.estimateBps ?? 0) < k.upgradeFactor * need)
      trouble = "bandwidth-limited";
    else if (estimateTrouble(s.estimateBps, inGrace ? k.baseBps + s.audioBps : need, inGrace))
      trouble = "estimate-drop";
    if (!trouble) {
      this.badSince = null;
      if (s.t - this.highSince >= k.stableMs) this.failures = 0;
      return null;
    }
    this.badSince ??= s.t;
    // Samples are ~1 s apart: the sample that opened the hold counts as one interval of trouble.
    if (s.t - this.badSince + SAMPLE_MS < k.downgradeHoldMs) return null;
    if (s.t - this.highSince < k.stableMs) this.failures++;
    else this.failures = 0;
    this.nextUpgradeAt = s.t + Math.min(k.backoffMs * 2 ** Math.max(0, this.failures - 1), k.maxBackoffMs);
    return this.set("base", trouble, s.t);
  }

  /** Track the base-level holds (headroom / probe). Idempotent for the same sample. */
  private lastTracked = Number.NaN;
  private track(s: PairSample) {
    if (s.t === this.lastTracked) return;
    this.lastTracked = s.t;
    const k = this.k;
    if (s.cpuLimited) this.lastCpuAt = s.t;
    const cpuClear = s.t - this.lastCpuAt >= k.cpuCooldownMs;
    const clean = cpuClear && (s.lossFraction ?? 0) < k.cleanLoss && s.limitation !== "cpu";
    const est = s.estimateBps;
    const good = clean && est !== undefined && est >= k.upgradeFactor * (k.highBps + s.audioBps);
    const probe = clean && est !== undefined && est >= k.probeFloorFactor * (k.baseBps + s.audioBps);
    this.goodSince = good ? (this.goodSince ?? s.t) : null;
    this.probeSince = probe ? (this.probeSince ?? s.t) : null;
  }

  private resetHolds() {
    this.goodSince = null;
    this.probeSince = null;
    this.badSince = null;
  }

  private set(level: SendLevel, reason: LevelReason, t: number): LevelChange {
    this._level = level;
    this._lastReason = reason;
    this.resetHolds();
    if (level === "high") this.highSince = t;
    return { level, reason };
  }
}

/**
 * Per-sender coordinator over the pair controllers (keyed by peer id). Shares the CPU signal and staggers upgrades.
 */
export class SenderLevels {
  private pairs = new Map<string, LevelController>();
  private lastUpgradeAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly k: LevelTuning = DEFAULT_LEVEL_TUNING) {}

  level(id: string): SendLevel {
    return this.pairs.get(id)?.level ?? "base";
  }

  reason(id: string): LevelReason | undefined {
    return this.pairs.get(id)?.lastReason;
  }

  /** Forget a pair (left, or its pc was rebuilt: a fresh pair starts at base). */
  reset(id: string): void {
    this.pairs.delete(id);
  }

  /** One sampler tick for every pair. Returns the pairs whose level changed. */
  update(samples: ReadonlyMap<string, PairSample>): Map<string, LevelChange> {
    const out = new Map<string, LevelChange>();
    for (const id of [...this.pairs.keys()]) if (!samples.has(id)) this.pairs.delete(id);
    let cpu = false;
    for (const s of samples.values()) if (s.limitation === "cpu" || s.cpuLimited) cpu = true;
    // Downgrades first (never staggered), then at most one upgrade per stagger window.
    const candidates: [string, PairSample, LevelController][] = [];
    for (const [id, raw] of samples) {
      const s = { ...raw, cpuLimited: cpu };
      let c = this.pairs.get(id);
      if (!c) {
        c = new LevelController(this.k);
        this.pairs.set(id, c);
      }
      if (c.level === "base") {
        candidates.push([id, s, c]);
        continue;
      }
      const ch = c.update(s);
      if (ch) out.set(id, ch);
    }
    let t = Number.NEGATIVE_INFINITY;
    for (const [, s] of candidates) t = Math.max(t, s.t);
    let allow = t - this.lastUpgradeAt >= this.k.staggerMs;
    for (const [id, s, c] of candidates) {
      const ch = c.update(s, allow);
      if (ch) {
        out.set(id, ch);
        if (ch.level === "high") {
          this.lastUpgradeAt = s.t;
          allow = false;
        }
      }
    }
    return out;
  }
}
