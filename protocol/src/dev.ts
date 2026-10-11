/**
 * Dev-only telemetry wire shapes (`/api/dev/config`, `/api/dev/log`). Enabled only when the Worker has DEV_TELEMETRY="1".
 * Privacy: payloads must never contain display names, SDP, keys or signal blobs — clients strip `name` before sending.
 */

export const DEV_LOG_MAX_BYTES = 256 * 1024;

export interface DevConfig {
  telemetry: boolean;
}

export type DevLogLevel = "debug" | "info" | "warn" | "error";

export interface DevLogEntry {
  t: number;
  level: DevLogLevel;
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface DevLogBatch {
  /** Sender's peerId (or "lobby-<random>" before joining). */
  peer: string;
  entries: DevLogEntry[];
  /** QaStatsSample objects with participant names removed. Opaque to the Worker: printed compactly, not validated deeply. */
  samples?: unknown[];
}

const LEVELS: readonly DevLogLevel[] = ["debug", "info", "warn", "error"];

export function parseDevLogBatch(raw: unknown): DevLogBatch | null {
  let m: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > DEV_LOG_MAX_BYTES) return null;
    try {
      m = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof m !== "object" || m === null) return null;
  const b = m as Record<string, unknown>;
  if (typeof b.peer !== "string" || b.peer.length > 64 || !Array.isArray(b.entries)) return null;
  const entries: DevLogEntry[] = [];
  for (const e of b.entries) {
    if (typeof e !== "object" || e === null) return null;
    const x = e as Record<string, unknown>;
    if (typeof x.t !== "number" || !LEVELS.includes(x.level as DevLogLevel)) return null;
    if (typeof x.scope !== "string" || typeof x.msg !== "string") return null;
    const data =
      typeof x.data === "object" && x.data !== null ? (x.data as Record<string, unknown>) : undefined;
    entries.push({
      t: x.t,
      level: x.level as DevLogLevel,
      scope: x.scope,
      msg: x.msg,
      ...(data ? { data } : {}),
    });
  }
  const samples = Array.isArray(b.samples) ? b.samples : undefined;
  return { peer: b.peer, entries, ...(samples ? { samples } : {}) };
}
