/** Per-socket message rate limit: token bucket, BURST tokens, refilled at RATE per second. */
export const RATE_LIMIT_BURST = 400;
export const RATE_LIMIT_PER_SECOND = 50;
/**
 * Rejected messages are counted in a leaky counter draining at RATE_LIMIT_STRIKE_DRAIN_PER_SECOND; reaching
 * this many means sustained abuse and the socket is closed (CLOSE.ABUSE). E.g. an instant flood trips it 200
 * messages past the burst; 100 msg/s sustained trips it ~5 s after the burst is spent; ≤ 60 msg/s never does.
 */
export const RATE_LIMIT_ABUSE_STRIKES = 200;
export const RATE_LIMIT_STRIKE_DRAIN_PER_SECOND = 10;
/** `error{rate-limited}` is sent at most once per this interval (no amplification). */
export const RATE_LIMIT_NOTIFY_INTERVAL_MS = 5_000;

export type Verdict =
  /** Message accepted. */
  | "ok"
  /** Rejected; tell the client (`error{rate-limited}`). */
  | "limited"
  /** Rejected silently (already told recently). */
  | "dropped"
  /** Sustained abuse: close the socket. */
  | "abuse";

export class TokenBucket {
  private tokens: number;
  private strikes = 0;
  private last: number;
  private notifiedAt = Number.NEGATIVE_INFINITY;

  constructor(
    now: number,
    private readonly burst = RATE_LIMIT_BURST,
    private readonly perSecond = RATE_LIMIT_PER_SECOND,
    private readonly abuseStrikes = RATE_LIMIT_ABUSE_STRIKES,
    private readonly strikeDrain = RATE_LIMIT_STRIKE_DRAIN_PER_SECOND,
  ) {
    this.tokens = burst;
    this.last = now;
  }

  take(now: number): Verdict {
    if (now > this.last) {
      const seconds = (now - this.last) / 1000;
      this.tokens = Math.min(this.burst, this.tokens + seconds * this.perSecond);
      this.strikes = Math.max(0, this.strikes - seconds * this.strikeDrain);
      this.last = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return "ok";
    }
    this.strikes += 1;
    if (this.strikes >= this.abuseStrikes) return "abuse";
    if (now - this.notifiedAt >= RATE_LIMIT_NOTIFY_INTERVAL_MS) {
      this.notifiedAt = now;
      return "limited";
    }
    return "dropped";
  }
}
