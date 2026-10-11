/**
 * Pure summaries of the QA stats timeline (`__clearcall.statsTimeline()`, 1 Hz QaStatsSample) — used by the lab
 * report and the diag summary. Cumulative WebRTC counters are diffed between the first and last sample.
 */
import type { QaPeerStats, QaStatsSample } from "../../web/src/core/types.ts";

export type { QaPeerStats, QaStatsSample };

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Nearest-rank percentile (p in 0..100). */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))]!;
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const nums = (xs: unknown[]): number[] => xs.filter(isNum);

export interface RemoteSummary {
  id: string;
  /** Seconds frozen / seconds observed (video), from totalFreezesDuration. */
  freeze_ratio: number | null;
  freeze_count: number | null;
  /** concealedSamples / totalSamplesReceived over the window (audio). */
  concealment_ratio: number | null;
  audio_packets_lost: number | null;
  frames_decoded: number | null;
  fps_mean: number | null;
  frame_height_mean: number | null;
  decode_ms_mean: number | null;
  jitter_buffer_ms_mean: number | null;
  rtt_ms_mean: number | null;
  candidate_type: string | null;
  quality_limitation: Record<string, number>;
  codec_video: string | null;
  codec_audio: string | null;
}

export interface TimelineSummary {
  samples: number;
  duration_s: number;
  send_kbps_mean: number | null;
  send_kbps_p95: number | null;
  recv_kbps_mean: number | null;
  recv_kbps_p95: number | null;
  /** send + receive per sample — the bandwidth budget metric. */
  total_kbps_mean: number | null;
  total_kbps_p95: number | null;
  rtt_ms_mean: number | null;
  rtt_ms_p95: number | null;
  encode_ms_mean: number | null;
  encode_ms_p95: number | null;
  long_task_ms_per_s: number | null;
  heap_mb_max: number | null;
  freeze_ratio_max: number | null;
  concealment_ratio_max: number | null;
  remotes: RemoteSummary[];
}

function sendKbps(s: QaStatsSample): number | undefined {
  if (isNum(s.local.outboundKbps)) return s.local.outboundKbps;
  const v = nums(s.peers.map((p) => p.outboundKbps));
  return v.length ? v.reduce((a, b) => a + b, 0) : undefined;
}
function recvKbps(s: QaStatsSample): number | undefined {
  if (isNum(s.local.inboundKbps)) return s.local.inboundKbps;
  const v = nums(s.peers.map((p) => p.inboundKbps));
  return v.length ? v.reduce((a, b) => a + b, 0) : undefined;
}

/** Δ of a cumulative counter between the first and last sample where it is defined. */
function delta(series: (number | undefined)[]): number | null {
  const v = nums(series);
  return v.length >= 2 ? v[v.length - 1]! - v[0]! : null;
}

function remoteSummary(id: string, rows: { t: number; p: QaPeerStats }[]): RemoteSummary {
  const span = rows.length >= 2 ? (rows[rows.length - 1]!.t - rows[0]!.t) / 1000 : 0;
  const freezeS = delta(rows.map((r) => r.p.video.totalFreezesDuration));
  const concealed = delta(rows.map((r) => r.p.audio.concealedSamples));
  const received = delta(rows.map((r) => r.p.audio.totalSamplesReceived));
  const ql: Record<string, number> = {};
  for (const r of rows) {
    const q = r.p.video.qualityLimitationReason;
    if (q) ql[q] = (ql[q] ?? 0) + 1;
  }
  const last = rows[rows.length - 1]?.p;
  return {
    id,
    freeze_ratio: freezeS !== null && span > 0 ? freezeS / span : null,
    freeze_count: delta(rows.map((r) => r.p.video.freezeCount)),
    concealment_ratio: concealed !== null && received ? concealed / received : null,
    audio_packets_lost: delta(rows.map((r) => r.p.audio.packetsLost)),
    frames_decoded: delta(rows.map((r) => r.p.video.framesDecoded)),
    fps_mean: mean(nums(rows.map((r) => r.p.video.framesPerSecond))),
    frame_height_mean: mean(nums(rows.map((r) => r.p.video.frameHeight))),
    decode_ms_mean: mean(nums(rows.map((r) => r.p.video.decodeMsPerFrame))),
    jitter_buffer_ms_mean: mean(nums(rows.map((r) => r.p.video.jitterBufferMs))),
    rtt_ms_mean: mean(nums(rows.map((r) => r.p.rttMs))),
    candidate_type: last?.candidateType ?? null,
    quality_limitation: ql,
    codec_video: last?.video.codec ?? null,
    codec_audio: last?.audio.codec ?? null,
  };
}

/**
 * Summarize one participant's timeline. `skipFirstS` drops the ramp-up (bandwidth estimation start) from rate
 * statistics; cumulative counters still use the whole window after the skip.
 */
export function summarizeTimeline(all: QaStatsSample[], skipFirstS = 5): TimelineSummary {
  const sorted = [...all].sort((a, b) => a.t - b.t);
  const t0 = sorted[0]?.t ?? 0;
  const s = sorted.filter((x) => x.t - t0 >= skipFirstS * 1000);
  const send = nums(s.map(sendKbps));
  const recv = nums(s.map(recvKbps));
  const total = s.map((x) => {
    const a = sendKbps(x);
    const b = recvKbps(x);
    return isNum(a) || isNum(b) ? (a ?? 0) + (b ?? 0) : undefined;
  });
  const rtts = nums(s.flatMap((x) => x.peers.map((p) => p.rttMs)));
  const enc = nums(s.map((x) => x.local.encodeMsPerFrame));
  const byPeer = new Map<string, { t: number; p: QaPeerStats }[]>();
  for (const x of s) for (const p of x.peers) byPeer.set(p.id, [...(byPeer.get(p.id) ?? []), { t: x.t, p }]);
  const remotes = [...byPeer.entries()].map(([id, rows]) => remoteSummary(id, rows));
  const lt = nums(s.map((x) => x.local.longTaskMs));
  const heap = nums(s.map((x) => x.local.heapMb));
  return {
    samples: s.length,
    duration_s: s.length >= 2 ? (s[s.length - 1]!.t - s[0]!.t) / 1000 : 0,
    send_kbps_mean: mean(send),
    send_kbps_p95: percentile(send, 95),
    recv_kbps_mean: mean(recv),
    recv_kbps_p95: percentile(recv, 95),
    total_kbps_mean: mean(nums(total)),
    total_kbps_p95: percentile(nums(total), 95),
    rtt_ms_mean: mean(rtts),
    rtt_ms_p95: percentile(rtts, 95),
    encode_ms_mean: mean(enc),
    encode_ms_p95: percentile(enc, 95),
    long_task_ms_per_s: mean(lt),
    heap_mb_max: heap.length ? Math.max(...heap) : null,
    freeze_ratio_max: maxOrNull(remotes.map((r) => r.freeze_ratio)),
    concealment_ratio_max: maxOrNull(remotes.map((r) => r.concealment_ratio)),
    remotes,
  };
}

export function maxOrNull(xs: (number | null | undefined)[]): number | null {
  const v = nums(xs);
  return v.length ? Math.max(...v) : null;
}

/** First sample time (ms since `t0`) at which `pred` holds, or null. */
export function firstTime(
  samples: QaStatsSample[],
  t0: number,
  pred: (s: QaStatsSample) => boolean,
): number | null {
  const hit = [...samples].sort((a, b) => a.t - b.t).find(pred);
  return hit ? hit.t - t0 : null;
}

/** Outbound kbps series (t in seconds since `t0`). */
export function sendSeries(samples: QaStatsSample[], t0: number): { t: number; kbps: number }[] {
  return samples
    .map((s) => ({ t: (s.t - t0) / 1000, kbps: sendKbps(s) }))
    .filter((x): x is { t: number; kbps: number } => isNum(x.kbps))
    .sort((a, b) => a.t - b.t);
}

/**
 * Adaptation speed for a bandwidth squeeze (bw_squeeze): link drops to `lowKbps` at `dropAt` s and returns at
 * `recoverAt` s. adapt_down_s = time until send rate ≤ lowKbps × 1.15; recover_up_s = time after recoverAt until the
 * send rate is back to ≥ 70 % of the mean in the 10 s before the drop. null = never within the window.
 */
export function adaptTimes(
  series: { t: number; kbps: number }[],
  dropAt: number,
  recoverAt: number,
  lowKbps: number,
): { adapt_down_s: number | null; recover_up_s: number | null; baseline_kbps: number | null } {
  const baseline = mean(series.filter((x) => x.t >= dropAt - 10 && x.t < dropAt).map((x) => x.kbps));
  const down = series.find((x) => x.t >= dropAt && x.t < recoverAt && x.kbps <= lowKbps * 1.15);
  const up = baseline === null ? undefined : series.find((x) => x.t >= recoverAt && x.kbps >= 0.7 * baseline);
  return {
    adapt_down_s: down ? down.t - dropAt : null,
    recover_up_s: up ? up.t - recoverAt : null,
    baseline_kbps: baseline,
  };
}
