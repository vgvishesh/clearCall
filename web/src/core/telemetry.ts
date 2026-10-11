/**
 * Dev-only telemetry: if `GET /api/dev/config` says `{telemetry:true}` (local Worker with DEV_TELEMETRY=1), ship new
 * log entries + stats samples to `POST /api/dev/log` every 2 s, and once more via `sendBeacon` on pagehide.
 * Privacy: participant names are stripped (and any `name` key in log data); never SDP/keys/blobs (we don't log them).
 */
import { DEV_LOG_MAX_BYTES, type DevLogBatch } from "@clearcall/protocol";
import type { Clock, TimerHandle } from "./clock.ts";
import type { LogSink } from "./log.ts";
import type { LogEntry, QaStatsSample } from "./types.ts";

const REDACT = new Set(["name", "sdp", "secret", "credential", "username"]);

function scrub(x: unknown, depth = 0): unknown {
  if (depth > 6 || x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) if (!REDACT.has(k)) out[k] = scrub(v, depth + 1);
  return out;
}

export function stripEntry(e: LogEntry): LogEntry {
  return e.data ? { ...e, data: scrub(e.data) as Record<string, unknown> } : e;
}

/** QaStatsSample without participant names. */
export function stripSample(s: QaStatsSample): unknown {
  return { ...s, peers: s.peers.map(({ name: _name, ...rest }) => rest) };
}

export interface TelemetryOptions {
  fetch: typeof fetch;
  sendBeacon?: (url: string, body: string) => boolean;
  clock: Clock;
  log: LogSink;
  /** Our peerId, or a stable "lobby-…" id before joining. */
  peer: () => string;
  /** All samples so far (ring); telemetry sends only those newer than the last shipped `t`. */
  samples: () => QaStatsSample[];
  intervalMs?: number;
  base?: string;
}

export interface Telemetry {
  readonly enabled: boolean;
  /** Ship now (pagehide uses beacon). */
  flush(beacon?: boolean): Promise<void>;
  stop(): void;
}

export function startTelemetry(o: TelemetryOptions): Telemetry {
  const base = o.base ?? "";
  let enabled = false;
  let stopped = false;
  let seq = 0;
  let lastSampleT = 0;
  let timer: TimerHandle | undefined;
  let inflight = false;

  const batch = (): DevLogBatch | null => {
    const entries = o.log.since(seq).map(stripEntry);
    const samples = o.samples().filter((s) => s.t > lastSampleT);
    if (!entries.length && !samples.length) return null;
    const b: DevLogBatch = { peer: o.peer(), entries };
    if (samples.length) b.samples = samples.map(stripSample);
    // Stay under the Worker's size limit: keep the newest entries.
    while (
      JSON.stringify(b).length > DEV_LOG_MAX_BYTES - 1024 &&
      (b.entries.length > 1 || b.samples?.length)
    ) {
      if (b.samples?.length) b.samples = b.samples.slice(Math.ceil(b.samples.length / 2));
      else b.entries = b.entries.slice(Math.ceil(b.entries.length / 2));
    }
    return b;
  };

  const commit = () => {
    seq = o.log.written;
    const s = o.samples();
    if (s.length) lastSampleT = s[s.length - 1]!.t;
  };

  const flush = async (beacon = false) => {
    if (!enabled || stopped || inflight) return;
    const b = batch();
    if (!b) return;
    const body = JSON.stringify(b);
    commit();
    if (beacon && o.sendBeacon) {
      try {
        o.sendBeacon(`${base}/api/dev/log`, body);
      } catch {}
      return;
    }
    inflight = true;
    try {
      await o.fetch(`${base}/api/dev/log`, {
        method: "POST",
        body,
        headers: { "content-type": "text/plain" },
      });
    } catch {
      // Dev aid only; never let it disturb a call.
    } finally {
      inflight = false;
    }
  };

  void (async () => {
    try {
      const res = await o.fetch(`${base}/api/dev/config`);
      if (!res.ok) return;
      const cfg = (await res.json()) as { telemetry?: unknown };
      if (cfg?.telemetry !== true || stopped) return;
      enabled = true;
      timer = o.clock.setInterval(() => void flush(), o.intervalMs ?? 2000);
    } catch {}
  })();

  return {
    get enabled() {
      return enabled;
    },
    flush,
    stop() {
      stopped = true;
      o.clock.clearInterval(timer);
    },
  };
}
