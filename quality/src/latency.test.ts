import { describe, expect, it } from "vitest";
import { type Envelope, envelopeLatency } from "./latency.ts";

/** Speech-like envelope: random syllable bursts (seeded) over a noise floor. */
function speechEnv(seconds: number, dt: number, seed = 7): number[] {
  let x = seed;
  const rnd = () => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x / 2 ** 31;
  };
  const out: number[] = [];
  let level = -70;
  for (let i = 0; i < (seconds * 1000) / dt; i++) {
    if (rnd() < 0.01) level = rnd() < 0.5 ? -70 : -30 + rnd() * 20;
    out.push(level + rnd() * 3);
  }
  return out;
}

describe("envelopeLatency", () => {
  it("recovers a known one-way delay from shifted envelopes", () => {
    const dt = 128 / 48;
    const db = speechEnv(30, dt);
    const sender: Envelope = { t0: 1_000_000, dt, db };
    const delay = 137;
    // receiver: same envelope, started 2 s later, shifted by `delay`, slightly attenuated + jitter on the floor
    const skip = Math.round(2000 / dt);
    const receiver: Envelope = {
      t0: 1_000_000 + 2000 + delay,
      dt,
      db: db.slice(skip).map((v, i) => v - 3 + (i % 7) * 0.2),
    };
    const r = envelopeLatency(sender, receiver)!;
    expect(r.latency_ms).toBeGreaterThan(delay - 5);
    expect(r.latency_ms).toBeLessThan(delay + 5);
    expect(r.corr).toBeGreaterThan(0.9);
    expect(r.windows.length).toBeGreaterThan(0);
  });

  it("returns null for too little overlap", () => {
    const e: Envelope = { t0: 0, dt: 2.67, db: [1, 2, 3] };
    expect(envelopeLatency(e, e)).toBeNull();
  });
});
