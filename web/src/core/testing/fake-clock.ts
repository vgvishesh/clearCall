/** Deterministic Clock for unit tests. Time only moves on `advance()`. Test-only (never imported by app code). */
import type { Clock, TimerHandle } from "../clock.ts";

interface Timer {
  id: number;
  at: number;
  fn: () => void;
  every?: number;
}

export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private timers = new Map<number, Timer>();

  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }

  now = (): number => this.t;

  setTimeout = (fn: () => void, ms: number): TimerHandle => {
    const id = ++this.seq;
    this.timers.set(id, { id, at: this.t + Math.max(0, ms), fn });
    return id;
  };

  setInterval = (fn: () => void, ms: number): TimerHandle => {
    const id = ++this.seq;
    const every = Math.max(1, ms);
    this.timers.set(id, { id, at: this.t + every, fn, every });
    return id;
  };

  clearTimeout = (h: TimerHandle | undefined): void => {
    if (typeof h === "number") this.timers.delete(h);
  };

  clearInterval = (h: TimerHandle | undefined): void => {
    if (typeof h === "number") this.timers.delete(h);
  };

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Move time forward, firing due timers in order. Synchronous: callers flush promises themselves. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: Timer | undefined;
      for (const timer of this.timers.values())
        if (timer.at <= end && (!next || timer.at < next.at)) next = timer;
      if (!next) break;
      this.t = next.at;
      if (next.every) next.at += next.every;
      else this.timers.delete(next.id);
      next.fn();
    }
    this.t = end;
  }
}

/** Let pending promise chains (and real WebCrypto work) settle. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => globalThis.setTimeout(r, 0));
}

/** Advance fake time in steps, settling promises between steps (for flows mixing timers and async work). */
export async function advanceAndSettle(clock: FakeClock, ms: number, step = 100): Promise<void> {
  for (let done = 0; done < ms; done += step) {
    clock.advance(Math.min(step, ms - done));
    await settle(3);
  }
}
