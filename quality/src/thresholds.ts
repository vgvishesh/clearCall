/**
 * Threshold gates. Source: quality/thresholds.yaml (owner-adopted) if present, else thresholds.proposed.yaml
 * (labelled "proposed" everywhere). Keys: `<metric>_min` (value ≥ limit), `<metric>_max` (value ≤ limit),
 * `<metric>: true` (boolean metric must be true). Profile entries override `defaults`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { QUALITY_DIR } from "./util.ts";

export type ThresholdSource = "adopted" | "proposed";
export type Limit = number | boolean;

export interface ThresholdSet {
  source: ThresholdSource;
  file: string;
  defaults: Record<string, Limit>;
  profiles: Record<string, Record<string, Limit>>;
}

export type MetricValue = number | boolean | null | undefined;

export interface GateRow {
  key: string;
  metric: string;
  op: ">=" | "<=" | "==";
  limit: Limit;
  value: MetricValue;
  /** fail = breach; error = the metric should have been measured but the scorer failed; not-measured = lab can't measure it yet. */
  status: "pass" | "fail" | "error" | "not-measured";
  note?: string;
}

export interface Evaluation {
  source: ThresholdSource;
  rows: GateRow[];
  /** True when any row is fail or error. */
  breached: boolean;
}

function isLimitMap(x: unknown): x is Record<string, Limit> {
  return (
    typeof x === "object" &&
    x !== null &&
    Object.values(x).every((v) => typeof v === "number" || typeof v === "boolean")
  );
}

export function parseThresholds(text: string, source: ThresholdSource, file = ""): ThresholdSet {
  const raw = (parse(text) ?? {}) as Record<string, unknown>;
  const defaults = raw.defaults ?? {};
  if (!isLimitMap(defaults)) throw new Error(`${file}: defaults must map keys to numbers/booleans`);
  const profiles: Record<string, Record<string, Limit>> = {};
  for (const [name, v] of Object.entries((raw.profiles ?? {}) as Record<string, unknown>)) {
    if (!isLimitMap(v)) throw new Error(`${file}: profiles.${name} must map keys to numbers/booleans`);
    profiles[name] = v;
  }
  return { source, file, defaults, profiles };
}

/** thresholds.yaml wins; else the proposed file. */
export function loadThresholds(dir = QUALITY_DIR): ThresholdSet {
  const adopted = join(dir, "thresholds.yaml");
  if (existsSync(adopted)) return parseThresholds(readFileSync(adopted, "utf8"), "adopted", adopted);
  const proposed = join(dir, "thresholds.proposed.yaml");
  return parseThresholds(readFileSync(proposed, "utf8"), "proposed", proposed);
}

/** Effective gate map for a profile (profile keys override defaults). */
export function gatesFor(t: ThresholdSet, profile: string): Record<string, Limit> {
  return { ...t.defaults, ...(t.profiles[profile] ?? {}) };
}

export function splitKey(key: string): { metric: string; op: GateRow["op"] } {
  if (key.endsWith("_min")) return { metric: key.slice(0, -4), op: ">=" };
  if (key.endsWith("_max")) return { metric: key.slice(0, -4), op: "<=" };
  return { metric: key, op: "==" };
}

/**
 * Evaluate measured metrics against a profile's gates.
 * `errors[metric]` marks a metric whose scorer failed (→ status error, counts as a breach);
 * metrics absent from both maps are "not-measured" (listed, not a breach).
 */
export function evaluate(
  t: ThresholdSet,
  profile: string,
  metrics: Record<string, MetricValue>,
  errors: Record<string, string> = {},
): Evaluation {
  const rows: GateRow[] = [];
  for (const [key, limit] of Object.entries(gatesFor(t, profile))) {
    const { metric, op } = splitKey(key);
    const value = metrics[metric];
    const row: GateRow = { key, metric, op, limit, value, status: "pass" };
    if (errors[metric]) {
      row.status = "error";
      row.note = errors[metric];
    } else if (value === undefined || value === null || (typeof value === "number" && Number.isNaN(value))) {
      row.status = "not-measured";
    } else if (op === "==") {
      row.status = value === limit ? "pass" : "fail";
    } else if (typeof value !== "number" || typeof limit !== "number") {
      row.status = "error";
      row.note = `expected numbers for ${key}`;
    } else {
      row.status = (op === ">=" ? value >= limit : value <= limit) ? "pass" : "fail";
    }
    rows.push(row);
  }
  return { source: t.source, rows, breached: rows.some((r) => r.status === "fail" || r.status === "error") };
}
