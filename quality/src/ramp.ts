/**
 * Video ramp-up after join: how long until each outgoing stream reaches the policy's target resolution and
 * bitrate, and how far the send rate overshoots the policy cap on the way. Pure (timeline + logs in, numbers out).
 *
 * - target height / cap = the last `policy applied` (kind video) log entry for that remote — what our own policy
 *   asked the encoder for (tier ∧ receiver view). Falls back to the highest height seen when no log exists.
 * - time_to_target_s: Join click → first 1 Hz sample whose sent frame height ≥ target AND stays there for
 *   `sustain` consecutive samples (a one-sample blip doesn't count).
 * - time_to_kbps_s: Join click → first sample with send rate ≥ 80 % of the cap, sustained the same way.
 * - overshoot_pct: max send kbps over the cap, in % of the cap (0 = never above).
 */
import type { LogEntry, QaStatsSample } from "../../web/src/core/types.ts";

export interface RampResult {
  remote: string;
  target_height: number | null;
  cap_kbps: number | null;
  /** Height of the first sample with video going out (what the encoder started at). */
  start_height: number | null;
  time_to_target_s: number | null;
  time_to_kbps_s: number | null;
  overshoot_pct: number | null;
  /** [seconds since join, sent height, send kbps] — compact trace for the report. */
  trace: [number, number | null, number | null][];
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function lastPolicy(logs: readonly LogEntry[], remoteId: string) {
  let found: { height: number; kbps: number } | null = null;
  for (const e of logs) {
    if (e.msg !== "policy applied" || e.data?.kind !== "video") continue;
    const peer = String(e.data.peer ?? "");
    if (!peer || !remoteId.startsWith(peer.replace(/…$/, ""))) continue;
    const h = e.data.targetHeight;
    const b = e.data.maxBitrate;
    if (isNum(h) && isNum(b)) found = { height: h, kbps: b / 1000 };
  }
  return found;
}

/** First index i such that pred holds for samples i..i+sustain-1 (or to the end when fewer remain). */
function firstSustained<T>(xs: readonly T[], pred: (x: T) => boolean, sustain: number): number {
  for (let i = 0; i < xs.length; i++) {
    let ok = true;
    for (let j = i; j < Math.min(xs.length, i + sustain); j++)
      if (!pred(xs[j]!)) {
        ok = false;
        break;
      }
    if (ok) return i;
  }
  return -1;
}

export function rampFor(
  timeline: readonly QaStatsSample[],
  logs: readonly LogEntry[],
  joinAt: number,
  sustain = 3,
): RampResult[] {
  const remotes = [...new Set(timeline.flatMap((s) => s.peers.map((p) => p.id)))];
  return remotes.map((remote) => {
    const rows = timeline
      .map((s) => {
        const p = s.peers.find((x) => x.id === remote);
        return p ? { t: (s.t - joinAt) / 1000, h: p.video.sentFrameHeight, kbps: p.outboundKbps } : null;
      })
      .filter((r): r is { t: number; h: number | undefined; kbps: number | undefined } => r !== null);
    const policy = lastPolicy(logs, remote);
    const maxSeen = Math.max(0, ...rows.map((r) => r.h).filter(isNum));
    const target = policy?.height ?? (maxSeen || null);
    const cap = policy?.kbps ?? null;
    const sending = rows.filter((r) => isNum(r.h) && r.h > 0);
    const iH = target === null ? -1 : firstSustained(sending, (r) => (r.h ?? 0) >= target, sustain);
    const withKbps = rows.filter((r) => isNum(r.kbps));
    const iK = cap === null ? -1 : firstSustained(withKbps, (r) => (r.kbps ?? 0) >= 0.8 * cap, sustain);
    const maxKbps = Math.max(0, ...withKbps.map((r) => r.kbps!));
    return {
      remote,
      target_height: target,
      cap_kbps: cap,
      start_height: sending[0]?.h ?? null,
      time_to_target_s: iH < 0 ? null : round(sending[iH]!.t),
      time_to_kbps_s: iK < 0 ? null : round(withKbps[iK]!.t),
      overshoot_pct: cap === null ? null : round(Math.max(0, (100 * (maxKbps - cap)) / cap)),
      trace: rows.map((r) => [round(r.t), r.h ?? null, r.kbps ?? null]),
    };
  });
}

const round = (x: number) => Math.round(x * 10) / 10;

/** Worst (slowest) stream across a set of ramp results; null when any stream never reached its target. */
export function worstRamp(rs: readonly RampResult[]): {
  time_to_target_s: number | null;
  time_to_kbps_s: number | null;
  overshoot_pct: number | null;
} {
  const worst = (k: "time_to_target_s" | "time_to_kbps_s" | "overshoot_pct") =>
    rs.length === 0 || rs.some((r) => r[k] === null) ? null : Math.max(...rs.map((r) => r[k]!));
  return {
    time_to_target_s: worst("time_to_target_s"),
    time_to_kbps_s: worst("time_to_kbps_s"),
    overshoot_pct: worst("overshoot_pct"),
  };
}
