/**
 * Structured logger: one ring buffer (last 2000 entries) shared by every core module.
 * Read via `window.__clearcall.logs()` (qa.ts) and shipped to the dev Worker by telemetry.ts.
 * Never log SDP bodies, keys, signal blobs or people's names.
 */
import type { LogEntry, LogLevel } from "./types.ts";

export const LOG_CAPACITY = 2000;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface LogSink {
  scope(name: string): Logger;
  /** Snapshot, oldest first. */
  entries(): LogEntry[];
  /** Monotonic count of entries ever written (for incremental readers like telemetry). */
  readonly written: number;
  /** Entries with sequence number ≥ `seq` that are still in the ring. */
  since(seq: number): LogEntry[];
}

export interface LogOptions {
  now?: () => number;
  capacity?: number;
  /** Mirror entries at or above this level to `console` (default "warn"; "debug" with ?debug=1). Null = never. */
  consoleLevel?: LogLevel | null;
  console?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

export function createLog(opts: LogOptions = {}): LogSink {
  const now = opts.now ?? Date.now;
  const capacity = opts.capacity ?? LOG_CAPACITY;
  const consoleLevel = opts.consoleLevel === undefined ? "warn" : opts.consoleLevel;
  const out = opts.console ?? globalThis.console;
  const ring: LogEntry[] = [];
  let written = 0;

  const write = (level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>) => {
    const entry: LogEntry = data ? { t: now(), level, scope, msg, data } : { t: now(), level, scope, msg };
    if (ring.length >= capacity) ring.shift();
    ring.push(entry);
    written++;
    if (consoleLevel !== null && LEVEL_RANK[level] >= LEVEL_RANK[consoleLevel]) {
      out?.[level]?.(`[${scope}] ${msg}`, data ?? "");
    }
  };

  return {
    scope(name) {
      return {
        debug: (m, d) => write("debug", name, m, d),
        info: (m, d) => write("info", name, m, d),
        warn: (m, d) => write("warn", name, m, d),
        error: (m, d) => write("error", name, m, d),
      };
    },
    entries: () => ring.slice(),
    get written() {
      return written;
    },
    since(seq) {
      const firstSeq = written - ring.length;
      return ring.slice(Math.max(0, seq - firstSeq));
    },
  };
}

/** Logger that drops everything (default for modules constructed without one). */
export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Short, non-identifying form of a peer id for logs. */
export const short = (peerId: string): string => peerId.slice(0, 6);

/**
 * Turn an unknown thrown value into a small JSON-safe description.
 * Keys deliberately avoid `name`/`data`/`sdp`/... which the dev Worker redacts at any depth.
 */
export function errInfo(e: unknown): { err: string; message: string } {
  if (e && typeof e === "object") {
    const x = e as { name?: unknown; message?: unknown };
    return { err: String(x.name ?? "Error"), message: String(x.message ?? "") };
  }
  return { err: "Error", message: String(e) };
}
