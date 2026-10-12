/**
 * getStats → QaPeerStats (missing browser fields stay undefined, never throw), connection-quality badge, and the
 * 1 Hz QaStatsSample sampler (600-sample ring) that feeds the QA hook, telemetry and quality badges.
 */
import type { Clock, TimerHandle } from "./clock.ts";
import { errInfo, type Logger, nullLogger } from "./log.ts";
import type { ConnectionQuality, QaPeerStats, QaStatsSample } from "./types.ts";

export const TIMELINE_CAPACITY = 600;

type Stat = Record<string, unknown> & { id?: string; type?: string };
/** RTCStatsReport or any Map-like of stats (tests). */
export type StatsReportLike = { forEach(cb: (value: Stat, key: string) => void): void };

const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
const round = (x: number | undefined, digits = 2): number | undefined =>
  x === undefined ? undefined : Math.round(x * 10 ** digits) / 10 ** digits;

/** Badge thresholds (webrtc-media skill): good RTT<200 & loss<2 %; fair RTT<400 & loss<6 %; else poor. */
export function qualityFrom(rttMs: number | undefined, lossFraction: number | undefined): ConnectionQuality {
  if (rttMs === undefined && lossFraction === undefined) return "unknown";
  const rtt = rttMs ?? 0;
  const loss = lossFraction ?? 0;
  if (rtt < 200 && loss < 0.02) return "good";
  if (rtt < 400 && loss < 0.06) return "fair";
  return "poor";
}

interface Raw {
  t: number;
  bytesIn: number;
  bytesOut: number;
  packetsLost: number;
  packetsReceived: number;
  framesEncoded: number;
  totalEncodeTime: number;
  framesDecoded: number;
  totalDecodeTime: number;
}

export interface PeerStatsResult {
  stats: QaPeerStats;
  quality: ConnectionQuality;
  raw: Raw;
}

/** Summarize one pc's report. `prev` (previous raw counters) enables per-interval rates. */
export function summarizePeerStats(
  report: StatsReportLike,
  meta: { id: string; name: string; connectionState: RTCPeerConnectionState },
  now: number,
  prev?: Raw,
): PeerStatsResult {
  const all = new Map<string, Stat>();
  report.forEach((v, k) => {
    all.set(k, v);
  });
  const byType = (t: string) => [...all.values()].filter((s) => s.type === t);
  const kindOf = (s: Stat) => str(s.kind) ?? str(s.mediaType);
  const codecOf = (s: Stat) => {
    const c = s.codecId ? all.get(String(s.codecId)) : undefined;
    return c ? str(c.mimeType)?.replace(/^(audio|video)\//, "") : undefined;
  };

  const inA = byType("inbound-rtp").find((s) => kindOf(s) === "audio");
  const inV = byType("inbound-rtp").find((s) => kindOf(s) === "video");
  const outA = byType("outbound-rtp").find((s) => kindOf(s) === "audio");
  const outV = byType("outbound-rtp").find((s) => kindOf(s) === "video");
  const remoteInV = byType("remote-inbound-rtp").find((s) => kindOf(s) === "video");

  // Selected candidate pair: transport.selectedCandidatePairId, else a succeeded+nominated/selected pair.
  const transport = byType("transport")[0];
  const pairs = byType("candidate-pair");
  const pair =
    (transport?.selectedCandidatePairId ? all.get(String(transport.selectedCandidatePairId)) : undefined) ??
    pairs.find((p) => p.selected === true) ??
    pairs.find((p) => p.state === "succeeded" && p.nominated === true);
  const localCand = pair?.localCandidateId ? all.get(String(pair.localCandidateId)) : undefined;
  const rtt = num(pair?.currentRoundTripTime);

  const ratio = (a: unknown, b: unknown) => {
    const x = num(a);
    const y = num(b);
    return x !== undefined && y ? (x / y) * 1000 : undefined;
  };

  const stats: QaPeerStats = {
    id: meta.id,
    name: meta.name,
    connectionState: meta.connectionState,
    candidateType: str(localCand?.candidateType),
    rttMs: rtt === undefined ? undefined : Math.round(rtt * 1000),
    availableOutgoingBitrate: num(pair?.availableOutgoingBitrate),
    audio: {
      bytesReceived: num(inA?.bytesReceived),
      bytesSent: num(outA?.bytesSent),
      packetsLost: num(inA?.packetsLost),
      jitter: num(inA?.jitter),
      audioLevel: num(inA?.audioLevel),
      concealedSamples: num(inA?.concealedSamples),
      totalSamplesReceived: num(inA?.totalSamplesReceived),
      codec: inA ? codecOf(inA) : outA ? codecOf(outA) : undefined,
    },
    video: {
      bytesReceived: num(inV?.bytesReceived),
      bytesSent: num(outV?.bytesSent),
      framesDecoded: num(inV?.framesDecoded),
      framesDropped: num(inV?.framesDropped),
      freezeCount: num(inV?.freezeCount),
      totalFreezesDuration: num(inV?.totalFreezesDuration),
      frameHeight: num(inV?.frameHeight),
      framesPerSecond: num(inV?.framesPerSecond),
      sentFrameHeight: num(outV?.frameHeight),
      qualityLimitationReason: str(outV?.qualityLimitationReason),
      decodeMsPerFrame: round(ratio(inV?.totalDecodeTime, inV?.framesDecoded)),
      encodeMsPerFrame: round(ratio(outV?.totalEncodeTime, outV?.framesEncoded)),
      jitterBufferMs: round(ratio(inV?.jitterBufferDelay, inV?.jitterBufferEmittedCount)),
      codec: inV ? codecOf(inV) : outV ? codecOf(outV) : undefined,
      remoteFractionLost: num(remoteInV?.fractionLost),
    },
  };

  const sum = (...xs: (number | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
  const raw: Raw = {
    t: now,
    bytesIn: sum(num(inA?.bytesReceived), num(inV?.bytesReceived)),
    bytesOut: sum(num(outA?.bytesSent), num(outV?.bytesSent)),
    packetsLost: sum(num(inA?.packetsLost), num(inV?.packetsLost)),
    packetsReceived: sum(num(inA?.packetsReceived), num(inV?.packetsReceived)),
    framesEncoded: num(outV?.framesEncoded) ?? 0,
    totalEncodeTime: num(outV?.totalEncodeTime) ?? 0,
    framesDecoded: num(inV?.framesDecoded) ?? 0,
    totalDecodeTime: num(inV?.totalDecodeTime) ?? 0,
  };

  let lossFraction: number | undefined;
  if (prev && now > prev.t) {
    const dt = (now - prev.t) / 1000;
    stats.inboundKbps = Math.max(0, Math.round(((raw.bytesIn - prev.bytesIn) * 8) / dt / 1000));
    stats.outboundKbps = Math.max(0, Math.round(((raw.bytesOut - prev.bytesOut) * 8) / dt / 1000));
    const lost = raw.packetsLost - prev.packetsLost;
    const recv = raw.packetsReceived - prev.packetsReceived;
    if (lost + recv > 0) lossFraction = Math.max(0, lost) / (Math.max(0, lost) + Math.max(0, recv));
    // Per-interval encode/decode cost is a better CPU signal than the lifetime average.
    const fe = raw.framesEncoded - prev.framesEncoded;
    if (fe > 0)
      stats.video.encodeMsPerFrame = round(((raw.totalEncodeTime - prev.totalEncodeTime) / fe) * 1000);
    const fd = raw.framesDecoded - prev.framesDecoded;
    if (fd > 0)
      stats.video.decodeMsPerFrame = round(((raw.totalDecodeTime - prev.totalDecodeTime) / fd) * 1000);
  }
  return { stats, quality: qualityFrom(stats.rttMs, lossFraction), raw };
}

// ── 1 Hz sampler ──

export interface SamplerOptions {
  clock: Clock;
  collect: () => Promise<QaPeerStats[]>;
  intervalMs?: number;
  capacity?: number;
  log?: Logger;
  PerformanceObserver?: typeof PerformanceObserver | undefined;
  performance?: { memory?: { usedJSHeapSize?: number } } | undefined;
  onSample?: (s: QaStatsSample) => void;
}

export class StatsSampler {
  private ring: QaStatsSample[] = [];
  private timer: TimerHandle | undefined;
  private busy = false;
  private longTaskMs = 0;
  private observer: PerformanceObserver | null = null;
  private readonly o: SamplerOptions & { log: Logger; intervalMs: number; capacity: number };

  constructor(opts: SamplerOptions) {
    this.o = { log: nullLogger, intervalMs: 1000, capacity: TIMELINE_CAPACITY, ...opts };
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.observeLongTasks();
    this.timer = this.o.clock.setInterval(() => void this.tick(), this.o.intervalMs);
  }

  stop(): void {
    this.o.clock.clearInterval(this.timer);
    this.timer = undefined;
    try {
      this.observer?.disconnect();
    } catch {}
    this.observer = null;
  }

  timeline(): QaStatsSample[] {
    return this.ring.slice();
  }

  latest(): QaStatsSample | undefined {
    return this.ring[this.ring.length - 1];
  }

  /** One sample now (also used by tests). */
  async tick(): Promise<QaStatsSample | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const peers = await this.o.collect();
      const enc = peers.map((p) => p.video.encodeMsPerFrame).filter((x): x is number => x !== undefined);
      const has = (k: "inboundKbps" | "outboundKbps") => peers.some((p) => p[k] !== undefined);
      const total = (k: "inboundKbps" | "outboundKbps") => peers.reduce((a, p) => a + (p[k] ?? 0), 0);
      const heap = this.o.performance?.memory?.usedJSHeapSize;
      const sample: QaStatsSample = {
        t: this.o.clock.now(),
        local: {
          ...(enc.length
            ? { encodeMsPerFrame: Math.round((enc.reduce((a, b) => a + b, 0) / enc.length) * 100) / 100 }
            : {}),
          ...(has("outboundKbps") ? { outboundKbps: total("outboundKbps") } : {}),
          ...(has("inboundKbps") ? { inboundKbps: total("inboundKbps") } : {}),
          ...(this.observer ? { longTaskMs: Math.round(this.longTaskMs) } : {}),
          ...(typeof heap === "number" ? { heapMb: Math.round((heap / 1048576) * 10) / 10 } : {}),
        },
        peers,
      };
      this.longTaskMs = 0;
      if (this.ring.length >= this.o.capacity) this.ring.shift();
      this.ring.push(sample);
      this.o.onSample?.(sample);
      return sample;
    } catch (e) {
      this.o.log.warn("stats sample failed", errInfo(e));
      return null;
    } finally {
      this.busy = false;
    }
  }

  private observeLongTasks() {
    const PO = this.o.PerformanceObserver;
    if (!PO || this.observer) return;
    try {
      if (!PO.supportedEntryTypes?.includes("longtask")) return;
      const obs = new PO((list) => {
        for (const e of list.getEntries()) this.longTaskMs += e.duration;
      });
      obs.observe({ type: "longtask", buffered: false });
      this.observer = obs;
    } catch {
      this.observer = null;
    }
  }
}
