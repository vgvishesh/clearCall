/**
 * Audio mouth-to-ear latency probe (package A, item 4) — works on ANY corpus, no special probe signal needed.
 *
 * In every page we tap (a) our own captured mic track (after browser NS/AGC/EC = what the encoder gets) and (b) each
 * remote's received audio track (after jitter buffer + decode = what playout gets) with an AnalyserNode, and record
 * a block-energy envelope (128-sample render quanta, ~2.7 ms) timestamped in epoch ms via
 * `AudioContext.getOutputTimestamp()`. All participants run on the same host clock (or the same Docker VM clock), so
 * the lag that maximizes the correlation of sender-local vs receiver-remote envelopes is the one-way
 * capture→playout latency: APM + encode + packetization + network + jitter buffer + decode.
 * Not included: the physical mic/speaker device buffers (fake devices in the lab) — add ~20–40 ms on real phones.
 * The app's CSP (`script-src 'self'`) forbids Blob AudioWorklets, hence the polled AnalyserNode (2048-sample window
 * every 20 ms, de-duplicated per render quantum).
 */
import type { Page } from "@playwright/test";

export interface Envelope {
  /** Epoch ms of block 0 (start of the block). */
  t0: number;
  /** Block duration (ms). */
  dt: number;
  /** Energy per block in dB (floor −90). */
  db: number[];
}

declare global {
  interface Window {
    __labEnv?: Record<string, { stop(): Envelope }>;
  }
}

/** Start an envelope probe in the page. `target` = "local" or a remote participant id. */
export async function startEnvelope(page: Page, key: string, target: string): Promise<void> {
  await page.evaluate(
    ([key, target]) => {
      const st = window.__clearcall!.state() as unknown as {
        local: { stream: MediaStream | null };
        participants: { id: string; stream: MediaStream | null }[];
      };
      const stream =
        target === "local" ? st.local.stream : st.participants.find((p) => p.id === target)?.stream;
      const track = stream?.getAudioTracks()[0];
      if (!track) throw new Error(`no audio track for ${target}`);
      const ctx = new AudioContext();
      void ctx.resume();
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      const Q = 128;
      const sr = ctx.sampleRate;
      const buf = new Float32Array(an.fftSize);
      const energies = new Map<number, number>();
      const offsets: number[] = [];
      let first = -1;
      const timer = setInterval(() => {
        if (ctx.state !== "running") return;
        an.getFloatTimeDomainData(buf);
        const endBlock = Math.round((ctx.currentTime * sr) / Q); // blocks rendered so far
        const n = buf.length / Q;
        for (let i = 0; i < n; i++) {
          const b = endBlock - n + i;
          if (b < 0 || energies.has(b)) continue;
          let e = 0;
          for (let j = i * Q; j < (i + 1) * Q; j++) e += buf[j]! * buf[j]!;
          energies.set(b, e / Q);
          if (first < 0) first = b;
        }
        const ts = ctx.getOutputTimestamp?.();
        if (ts?.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0)
          offsets.push(performance.timeOrigin + ts.performanceTime - ts.contextTime * 1000);
      }, 20);
      window.__labEnv = {
        ...(window.__labEnv ?? {}),
        [key]: {
          stop() {
            clearInterval(timer);
            src.disconnect();
            void ctx.close();
            const sorted = [...offsets].sort((a, b) => a - b);
            const off = sorted[Math.floor(sorted.length / 2)] ?? performance.timeOrigin;
            const last = Math.max(first, ...energies.keys());
            const db: number[] = [];
            for (let b = first; b <= last; b++) {
              const e = energies.get(b);
              db.push(e === undefined ? Number.NaN : Math.max(-90, 10 * Math.log10(e + 1e-12)));
            }
            return { t0: off + ((first * Q) / sr) * 1000, dt: (Q / sr) * 1000, db };
          },
        },
      };
    },
    [key, target] as const,
  );
}

export async function stopEnvelope(page: Page, key: string): Promise<Envelope | null> {
  return page
    .evaluate((k) => {
      const e = window.__labEnv?.[k]?.stop() ?? null;
      // NaN does not survive JSON: encode gaps as null
      return e ? { ...e, db: e.db.map((x) => (Number.isFinite(x) ? x : null)) } : null;
    }, key)
    .then((e) => (e ? { ...e, db: e.db.map((x) => (x === null ? Number.NaN : x)) } : null))
    .catch(() => null);
}

/** Resample an envelope onto a uniform epoch grid (nearest block). */
function onGrid(e: Envelope, start: number, step: number, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.round((start + i * step - e.t0) / e.dt);
    out[i] = k >= 0 && k < e.db.length ? e.db[k]! : Number.NaN;
  }
  return out;
}

function pearson(a: Float64Array, b: Float64Array, lag: number): { r: number; n: number } {
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let i = 0; i + lag < b.length && i < a.length; i++) {
    const x = a[i]!;
    const y = b[i + lag]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    n++;
    sa += x;
    sb += y;
    saa += x * x;
    sbb += y * y;
    sab += x * y;
  }
  if (n < 50) return { r: Number.NaN, n };
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) ** 2;
  const vb = sbb / n - (sb / n) ** 2;
  return { r: va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : Number.NaN, n };
}

export interface LatencyResult {
  /** Lag (ms) at the correlation peak over the whole window. */
  latency_ms: number;
  /** Peak Pearson correlation (≥ 0.5 = trustworthy). */
  corr: number;
  /** Per-window (10 s) lags: median and max, to see jitter-buffer growth. */
  windows: number[];
}

/**
 * Lag (receiver − sender) maximizing the envelope correlation, searched in [0, maxLagMs]. Pure.
 * `step` = grid resolution (ms).
 */
export function envelopeLatency(
  sender: Envelope,
  receiver: Envelope,
  { maxLagMs = 1500, step = 2.5, windowMs = 10_000 } = {},
): LatencyResult | null {
  const start = Math.max(sender.t0, receiver.t0 - maxLagMs);
  const end = Math.min(
    sender.t0 + sender.db.length * sender.dt,
    receiver.t0 + receiver.db.length * receiver.dt,
  );
  const n = Math.floor((end - start) / step);
  if (n < 400) return null;
  const s = onGrid(sender, start, step, n);
  const r = onGrid(receiver, start, step, n);
  const best = (a: Float64Array, b: Float64Array) => {
    let lag = -1;
    let corr = -2;
    for (let L = 0; L <= Math.round(maxLagMs / step); L++) {
      const p = pearson(a, b, L);
      if (Number.isFinite(p.r) && p.r > corr) {
        corr = p.r;
        lag = L;
      }
    }
    return lag < 0 ? null : { lag: lag * step, corr };
  };
  const all = best(s, r);
  if (!all) return null;
  const wn = Math.round(windowMs / step);
  const windows: number[] = [];
  const pad = Math.round(maxLagMs / step);
  for (let i = 0; i + wn + pad <= n; i += wn) {
    const w = best(s.subarray(i, i + wn), r.subarray(i, i + wn + pad));
    if (w && w.corr >= 0.5) windows.push(w.lag);
  }
  return { latency_ms: all.lag, corr: all.corr, windows };
}
