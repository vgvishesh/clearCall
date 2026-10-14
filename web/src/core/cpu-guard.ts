/**
 * CPU overload guard (ADR-0010). A device that can't keep up with video loses audio too: on a CPU-starved peer the
 * encoder, the decoder and the audio threads share the cores, and once the encoder alone needs a full core the
 * remote hears 3–60 % concealment ("robotic", then gone). Chrome reported no `qualityLimitationReason=cpu` in the lab
 * even at 100–290 ms/frame, so the guard reads the cost directly.
 *
 * Per sender (CPU is shared by every pair), from the 1 Hz stats sampler:
 * - Overloaded sample: the encoder takes ≥ 75 % of the frame interval (25 ms at 30 fps, 50 ms at 15 fps); or it takes
 *   ≥ 40 % AND the sent frame rate is < 85 % of what it should be (the level's target; at the normal level the
 *   camera's actual rate if lower — a dim room's 15 fps camera is not overload); or libwebrtc reports `cpu`; or the
 *   sampler itself ran ≥ 2.5 s late (the page's main thread was starved). The encode-time clause stands alone
 *   because a starved device's capture slows down with its encoder (lab, 0.5 core: camera 8–11 fps, sent 7–10 fps,
 *   encode 60–250 ms), which hid the frame-rate clause for 30 s.
 * - Overloaded = ≥ 6 of the last 10 samples. Then escalate one step and wait ESCALATE_HOLD_MS before judging again:
 *   1. "reduced": video ≤ 360p at 15 fps both ways (send caps + the view we report) — and, in the same step, drop
 *      software AV1/VP9 (renegotiate to VP8/H264: ~8× cheaper encode; sticky for the rest of the call). Doing both at
 *      once matters: a codec switch alone restarts the new encoder at 720p, which a starved device can't encode
 *      either (lab: VP8 at 100–290 ms/frame for 8 s before the next step);
 *   2. "paused": no video either way (encodings inactive + view 0), audio only.
 * - Recovery: one level after RECOVER_MS (60 s) with at most 1 overloaded sample per 10 — and, from "reduced", only
 *   with encode headroom: going back to 720p30 is ~4× the per-frame work, so the median encode time at 360p must be
 *   ≤ HEADROOM_MS (4 × that ≤ 40 % of a 30 fps frame). Lab, 0.5 core: a time-only recovery re-overloaded within
 *   10 s (encode 150–440 ms/frame, 32–43 % of the remote's audio concealed for ~20 s); at 360p that device encoded
 *   3.5–5 ms/frame. Each overload right after a
 *   recovery from that level doubles the wait; after MAX_RETRIES the level is kept for the rest of the call. Going
 *   back to 720p30 is 8× the encode work of 360p15 and every switch costs keyframes, so a device on the edge must not
 *   flap (lab: a 30 s recovery re-overloaded within 10 s).
 * - Hidden tab: samples are ignored (browsers throttle timers, which would look like starvation).
 */

export type CpuLevel = 0 | 1 | 2;
export const CPU_LEVEL_NAMES = ["normal", "reduced", "paused"] as const;

export interface CpuSample {
  t: number;
  /** Per-interval encode ms/frame of our video (max over pairs); undefined = not encoding. */
  encodeMs?: number | undefined;
  /** Sent frames per second (min over sending pairs); undefined = not encoding. */
  sentFps?: number | undefined;
  /** Camera frames per second (media-source stats); undefined = unknown (assume the target). */
  sourceFps?: number | undefined;
  /** libwebrtc says `qualityLimitationReason=cpu` on any pair. */
  cpuLimited: boolean;
  /** A pair currently uses a software-heavy codec (AV1/VP9 without hardware). */
  heavyCodec: boolean;
  /** Our tab is hidden (samples are ignored). */
  hidden: boolean;
}

export interface CpuAction {
  level: CpuLevel;
  reason: "overload" | "recovered";
  /** Also leave the heavy codecs out from now on (renegotiate). */
  codecFallback?: true;
}

export const WINDOW = 10;
export const TRIGGER = 6;
export const RECOVER_MAX_BAD = 1;
export const ESCALATE_HOLD_MS = 8_000;
export const RECOVER_MS = 60_000;
/** Re-escalations into the same level before it is kept for the rest of the call. */
export const MAX_RETRIES = 2;
export const GAP_MS = 2_500;
/** Max median encode ms/frame at the reduced level to try 720p30 again (4 × 3.3 ≈ 40 % of 33 ms). */
export const HEADROOM_MS = 3.3;

/** Target send frame rate at a level (policy: 30, reduced 15). */
export function targetFps(level: CpuLevel): number {
  return level === 0 ? 30 : 15;
}

export function overloaded(s: CpuSample, prevT: number | undefined, level: CpuLevel): boolean {
  if (prevT !== undefined && s.t - prevT >= GAP_MS) return true;
  if (s.cpuLimited) return true;
  if (s.encodeMs === undefined || s.sentFps === undefined) return false;
  const target = targetFps(level);
  const interval = 1000 / target;
  if (s.encodeMs >= 0.75 * interval) return true;
  const expected =
    level === 0 && s.sourceFps !== undefined && s.sourceFps > 0 ? Math.min(target, s.sourceFps) : target;
  return s.sentFps < 0.85 * expected && s.encodeMs >= 0.4 * interval;
}

export class CpuGuard {
  level: CpuLevel = 0;
  codecFallback: boolean;
  private window: boolean[] = [];
  private prevT: number | undefined;
  private holdUntil = 0;
  private since = 0;
  /** Per level we may recover from: current wait and how often it was re-entered right after a recovery. */
  private recover: Record<1 | 2, { ms: number; retries: number }> = {
    1: { ms: RECOVER_MS, retries: 0 },
    2: { ms: RECOVER_MS, retries: 0 },
  };
  private lastDownFrom: CpuLevel | null = null;
  /** Encode ms/frame samples since the last level change (for the recovery headroom check). */
  private encodes: number[] = [];

  /** `codecFallback` true = heavy codecs already excluded (constrained device). */
  constructor(opts: { codecFallback?: boolean } = {}) {
    this.codecFallback = opts.codecFallback ?? false;
  }

  update(s: CpuSample): CpuAction | null {
    if (s.hidden) {
      this.window = [];
      this.prevT = undefined;
      return null;
    }
    const bad = overloaded(s, this.prevT, this.level);
    this.prevT = s.t;
    if (s.encodeMs !== undefined) {
      this.encodes.push(s.encodeMs);
      if (this.encodes.length > 30) this.encodes.shift();
    }
    this.window.push(bad);
    if (this.window.length > WINDOW) this.window.shift();
    if (s.t < this.holdUntil) return null;
    const nBad = this.window.filter(Boolean).length;
    if (this.window.length >= WINDOW && nBad >= TRIGGER) return this.escalate(s);
    if (this.level > 0) {
      const r = this.recover[this.level as 1 | 2];
      if (
        r.retries <= MAX_RETRIES &&
        s.t - this.since >= r.ms &&
        nBad <= RECOVER_MAX_BAD &&
        (this.level !== 1 || this.headroom())
      ) {
        this.lastDownFrom = this.level;
        this.level = (this.level - 1) as CpuLevel;
        this.since = s.t;
        this.window = [];
        this.encodes = [];
        return { level: this.level, reason: "recovered" };
      }
    }
    return null;
  }

  /** Enough encode headroom at the reduced level to try 720p30 (no encode data = no evidence = no). */
  private headroom(): boolean {
    if (this.encodes.length < 10) return false;
    const sorted = [...this.encodes].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]! <= HEADROOM_MS;
  }

  private escalate(s: CpuSample): CpuAction | null {
    this.window = [];
    this.encodes = [];
    this.holdUntil = s.t + ESCALATE_HOLD_MS;
    const fallback = s.heavyCodec && !this.codecFallback;
    if (fallback) this.codecFallback = true;
    if (this.level >= 2) return null;
    const next = (this.level + 1) as 1 | 2;
    // Overloaded again after recovering from this level: wait longer next time; after MAX_RETRIES keep it.
    if (this.lastDownFrom === next) {
      const r = this.recover[next];
      r.retries += 1;
      r.ms *= 2;
    }
    this.lastDownFrom = null;
    this.level = next;
    this.since = s.t;
    return { level: next, reason: "overload", ...(fallback ? { codecFallback: true as const } : {}) };
  }
}
