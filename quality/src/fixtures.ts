/** Synthetic QA timelines for unit tests (not shipped to the app). */
import type { QaPeerStats, QaStatsSample } from "../../web/src/core/types.ts";

export interface SynthOptions {
  seconds: number;
  t0?: number;
  peers?: string[];
  sendKbps?: (t: number) => number;
  recvKbps?: (t: number) => number;
  /** Cumulative freeze seconds at time t for a peer. */
  freezeS?: (t: number, peer: string) => number;
  /** Cumulative concealed samples (48 kHz) at time t. */
  concealed?: (t: number, peer: string) => number;
  connection?: (t: number, peer: string) => RTCPeerConnectionState;
  framesPerS?: number;
  encodeMs?: (t: number) => number;
  longTaskMs?: (t: number) => number;
  rttMs?: number;
}

export function synthTimeline(o: SynthOptions): QaStatsSample[] {
  const t0 = o.t0 ?? 1_700_000_000_000;
  const peers = o.peers ?? ["peerB"];
  const out: QaStatsSample[] = [];
  for (let i = 0; i <= o.seconds; i++) {
    const t = i;
    const ps: QaPeerStats[] = peers.map((id) => ({
      id,
      name: "",
      connectionState: o.connection?.(t, id) ?? "connected",
      candidateType: "host",
      rttMs: o.rttMs ?? 20,
      audio: {
        bytesReceived: 4000 * t,
        concealedSamples: o.concealed?.(t, id) ?? 0,
        totalSamplesReceived: 48000 * t,
        packetsLost: 0,
        audioLevel: 0.1,
      },
      video: {
        bytesReceived: 100_000 * t,
        framesDecoded: (o.framesPerS ?? 30) * t,
        freezeCount: 0,
        totalFreezesDuration: o.freezeS?.(t, id) ?? 0,
        frameHeight: 720,
        framesPerSecond: o.framesPerS ?? 30,
        qualityLimitationReason: "none",
        encodeMsPerFrame: o.encodeMs?.(t),
      },
      inboundKbps: (o.recvKbps?.(t) ?? 1000) / peers.length,
      outboundKbps: (o.sendKbps?.(t) ?? 1000) / peers.length,
    }));
    out.push({
      t: t0 + i * 1000,
      local: {
        outboundKbps: o.sendKbps?.(t) ?? 1000,
        inboundKbps: o.recvKbps?.(t) ?? 1000,
        encodeMsPerFrame: o.encodeMs?.(t) ?? 5,
        longTaskMs: o.longTaskMs?.(t) ?? 0,
        heapMb: 30,
      },
      peers: ps,
    });
  }
  return out;
}
