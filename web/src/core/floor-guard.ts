/**
 * Congestion-controller floor guard (ADR-0009).
 *
 * 2-party calls set a floor under libwebrtc's bandwidth estimate (`x-google-min-bitrate`, policy.videoFloorKbps):
 * on a lossy, jittery link (3g_lossy: 400 kbps up, 5 % bursty loss, ±40 ms jitter) Chrome's estimate otherwise
 * decays to ~85 kbps — it reads random loss and in-order jitter as congestion — and video falls to ~40 kbps / 180p.
 * The floor stops that, but below the floor GCC can no longer back off for REAL congestion (a link slower than the
 * floor). This guard is that back-off, done at the app layer with the signal random loss can't fake: queueing.
 *
 * Per pair, 1 Hz samples. Only while the estimate sits at the floor (`floorBound`) or a cap is active:
 * - trouble = RTT above the 30 s windowed minimum + `rttRiseMs` (a standing queue), or receiver loss ≥ `heavyLoss`;
 * - `troubleHoldMs` of continuous trouble → cap the video encoder at `decrease` × what it sends now (≥ `minCapBps`);
 *   further decreases only every `drainMs` while trouble lasts (the queue needs time to drain after a cut, and RTT
 *   stays high meanwhile — bw_squeeze: two cuts in 4 s took the cap to the minimum);
 * - `recoverStepMs` without trouble → cap × `increase`; the cap is dropped once it reaches the floor (GCC's own
 *   estimate is then in charge again). bw_squeeze: ×1.15 / 4 s held video at the cap for ~20 s after the link
 *   recovered, so recovery is ×1.25 / 2 s.
 * The cap only ever lowers the encoder's maxBitrate (setParameters); the SDP floor itself stays, so no renegotiation.
 */

export interface FloorGuardTuning {
  rttWindowMs: number;
  rttRiseMs: number;
  heavyLoss: number;
  troubleHoldMs: number;
  drainMs: number;
  decrease: number;
  increase: number;
  recoverStepMs: number;
  minCapBps: number;
  floorBoundFactor: number;
}

export const DEFAULT_FLOOR_GUARD: FloorGuardTuning = {
  rttWindowMs: 30_000,
  rttRiseMs: 300,
  heavyLoss: 0.2,
  troubleHoldMs: 3_000,
  drainMs: 6_000,
  decrease: 0.6,
  increase: 1.25,
  recoverStepMs: 2_000,
  minCapBps: 50_000,
  floorBoundFactor: 1.15,
};

export interface GuardSample {
  /** ms */
  t: number;
  /** The floor this pair's SDP carries (bps); null = no floor → guard idle. */
  floorBps: number | null;
  /** candidate-pair availableOutgoingBitrate (bps). */
  estimateBps?: number | undefined;
  /** candidate-pair currentRoundTripTime (ms). */
  rttMs?: number | undefined;
  /** remote-inbound-rtp fractionLost of our video. */
  lossFraction?: number | undefined;
  /** What our video encoder sends this peer now (bps). */
  videoSendBps?: number | undefined;
}

export class FloorGuard {
  private rtts: { t: number; rtt: number }[] = [];
  private troubleSince: number | null = null;
  private lastChange = Number.NEGATIVE_INFINITY;
  private _cap: number | undefined;

  constructor(private readonly k: FloorGuardTuning = DEFAULT_FLOOR_GUARD) {}

  /** Current video cap (bps), undefined = none. */
  get cap(): number | undefined {
    return this._cap;
  }

  reset(): void {
    this.rtts = [];
    this.troubleSince = null;
    this.lastChange = Number.NEGATIVE_INFINITY;
    this._cap = undefined;
  }

  /** Feed one sample; returns the cap to apply (bps) or undefined for none. */
  update(s: GuardSample): number | undefined {
    if (s.floorBps === null || s.floorBps <= 0) {
      this.reset();
      return undefined;
    }
    const k = this.k;
    if (s.rttMs !== undefined && s.rttMs > 0) {
      this.rtts.push({ t: s.t, rtt: s.rttMs });
      while (this.rtts.length && this.rtts[0]!.t < s.t - k.rttWindowMs) this.rtts.shift();
    }
    const base = this.rtts.length ? Math.min(...this.rtts.map((r) => r.rtt)) : undefined;
    const floorBound = s.estimateBps !== undefined && s.estimateBps <= s.floorBps * k.floorBoundFactor;
    const watching = floorBound || this._cap !== undefined;
    const queueing = base !== undefined && s.rttMs !== undefined && s.rttMs > base + k.rttRiseMs;
    const heavyLoss = s.lossFraction !== undefined && s.lossFraction >= k.heavyLoss;
    const trouble = watching && (queueing || heavyLoss);

    if (trouble) {
      this.troubleSince ??= s.t;
      const drained = this._cap === undefined || s.t - this.lastChange >= k.drainMs;
      if (s.t - this.troubleSince >= k.troubleHoldMs && drained) {
        const now = s.videoSendBps ?? this._cap ?? s.floorBps;
        const next = Math.max(k.minCapBps, Math.round(Math.min(now, this._cap ?? now) * k.decrease));
        this._cap = next;
        this.lastChange = s.t;
        this.troubleSince = s.t; // next decrease only after another full hold
      }
      return this._cap;
    }
    this.troubleSince = null;
    if (this._cap !== undefined && s.t - this.lastChange >= k.recoverStepMs) {
      const next = Math.round(this._cap * k.increase);
      this.lastChange = s.t;
      this._cap = next >= s.floorBps ? undefined : next;
    }
    return this._cap;
  }
}
