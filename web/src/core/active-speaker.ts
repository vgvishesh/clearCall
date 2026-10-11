/**
 * Speaking detection + active speaker with hysteresis.
 * - Levels (0..1, from RTP audio-level via getSynchronizationSources, ~5 Hz) are smoothed: fast attack, slow release.
 * - `speaking`: smoothed level above `threshold`, held for `releaseMs` after it drops (no flicker between words).
 * - Active speaker: once chosen, kept for at least `holdMs` (1.5 s). After that it moves to the loudest speaking
 *   participant when the current one stopped speaking, or is clearly (×`margin`) quieter. Silence keeps the last
 *   speaker (stable layouts); a participant that leaves is cleared.
 */

export interface SpeakerOptions {
  threshold?: number;
  holdMs?: number;
  releaseMs?: number;
  margin?: number;
}

export interface SpeakerSnapshot {
  activeId: string | null;
  levels: Map<string, number>;
  speaking: Set<string>;
}

export class SpeakerTracker {
  private smoothed = new Map<string, number>();
  private lastLoud = new Map<string, number>();
  private active: string | null = null;
  private activeSince = 0;
  private readonly threshold: number;
  private readonly holdMs: number;
  private readonly releaseMs: number;
  private readonly margin: number;

  constructor(opts: SpeakerOptions = {}) {
    this.threshold = opts.threshold ?? 0.03;
    this.holdMs = opts.holdMs ?? 1500;
    this.releaseMs = opts.releaseMs ?? 600;
    this.margin = opts.margin ?? 1.5;
  }

  /** Feed raw levels for every current participant (missing ids are forgotten). */
  update(levels: Map<string, number>, now: number): SpeakerSnapshot {
    for (const id of [...this.smoothed.keys()]) {
      if (!levels.has(id)) {
        this.smoothed.delete(id);
        this.lastLoud.delete(id);
      }
    }
    if (this.active && !levels.has(this.active)) this.active = null;

    const speaking = new Set<string>();
    for (const [id, raw] of levels) {
      const level = Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 0));
      const prev = this.smoothed.get(id) ?? 0;
      const s = level >= prev ? level : prev * 0.6 + level * 0.4;
      this.smoothed.set(id, s);
      if (s >= this.threshold) this.lastLoud.set(id, now);
      const ll = this.lastLoud.get(id);
      if (ll !== undefined && now - ll < this.releaseMs) speaking.add(id);
    }

    let loudest: string | null = null;
    for (const id of speaking)
      if (!loudest || this.smoothed.get(id)! > this.smoothed.get(loudest)!) loudest = id;

    if (loudest && loudest !== this.active) {
      if (!this.active) this.set(loudest, now);
      else if (now - this.activeSince >= this.holdMs) {
        const cur = this.smoothed.get(this.active) ?? 0;
        const cand = this.smoothed.get(loudest) ?? 0;
        if (!speaking.has(this.active) || cand > cur * this.margin) this.set(loudest, now);
      }
    }
    return { activeId: this.active, levels: new Map(this.smoothed), speaking };
  }

  private set(id: string, now: number) {
    this.active = id;
    this.activeSince = now;
  }

  reset(): void {
    this.smoothed.clear();
    this.lastLoud.clear();
    this.active = null;
  }
}
