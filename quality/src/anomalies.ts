/**
 * Anomaly rules for `make diag` bundles. Pure: input = what diag collected, output = findings.
 * Hard anomalies make diag exit non-zero (they mean "the call is broken or we're blind"); soft ones are quality
 * smells worth reading before shipping.
 */
import type { LogEntry, QaStatsSample } from "../../web/src/core/types.ts";
import { summarizeTimeline } from "./metrics.ts";

export type Fault = "drop-signaling" | "restart-ice" | "kill-peer";
export interface FaultSpec {
  fault: Fault;
  atS: number;
  /** Participant index that injects (default 0). */
  peer: number;
}

/** `drop-signaling@20s`, `restart-ice@15:p1`, `kill-peer@30s:2`. */
export function parseFault(spec: string): FaultSpec {
  const m = /^(drop-signaling|restart-ice|kill-peer)@(\d+(?:\.\d+)?)s?(?::p?(\d+))?$/.exec(spec.trim());
  if (!m) throw new Error(`bad --fault "${spec}" (expected e.g. drop-signaling@20s or restart-ice@15s:p1)`);
  return { fault: m[1] as Fault, atS: Number(m[2]), peer: m[3] ? Number(m[3]) : 0 };
}

export interface PeerEvidence {
  label: string;
  /** ms from Join click until all remotes connected; null = never. */
  connectedMs: number | null;
  firstFrameMs: number | null;
  timeline: QaStatsSample[];
  logs: LogEntry[];
  pageErrors: string[];
  consoleErrors: string[];
  crashed: boolean;
  hasQaHook: boolean;
}

export interface DiagInput {
  participants: number;
  peers: PeerEvidence[];
  workerLog: string;
  faults: FaultSpec[];
  /** Session window start (epoch ms) — samples before it are ignored. */
  t0: number;
}

export interface Anomaly {
  severity: "hard" | "soft";
  rule: string;
  peer?: string;
  detail: string;
}

/** ADR-0005 per-connection video caps (kbps) by participant count. */
export function policyTargetKbps(participants: number): number {
  if (participants <= 2) return 1500;
  if (participants <= 4) return 600;
  return 150;
}

/** Latest video maxBitrate the policy module logged (bps → kbps), if any. */
export function loggedPolicyKbps(logs: LogEntry[]): number | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const e = logs[i]!;
    if (e.scope !== "policy" || !e.data) continue;
    const d = e.data as Record<string, unknown>;
    const v =
      d.videoMaxBitrate ?? d.maxBitrate ?? (d.video as Record<string, unknown> | undefined)?.maxBitrate;
    if (typeof v === "number" && v > 0) return v / 1000;
  }
  return null;
}

/** Longest run (s) of consecutive samples where `pred` holds. */
export function longestRun(samples: QaStatsSample[], pred: (s: QaStatsSample) => boolean): number {
  let best = 0;
  let start: number | null = null;
  for (const s of [...samples].sort((a, b) => a.t - b.t)) {
    if (pred(s)) {
      if (start === null) start = s.t;
      best = Math.max(best, (s.t - start) / 1000 + 1);
    } else start = null;
  }
  return best;
}

export function countTelemetry(workerLog: string): { client: number; stats: number } {
  return {
    client: (workerLog.match(/\[client /g) ?? []).length,
    stats: (workerLog.match(/\[stats /g) ?? []).length,
  };
}

export function findAnomalies(input: DiagInput): Anomaly[] {
  const out: Anomaly[] = [];
  const faulted = input.faults.length > 0;
  const tel = countTelemetry(input.workerLog);
  if (tel.client === 0 || tel.stats === 0)
    out.push({
      severity: "hard",
      rule: "no-telemetry",
      detail: `worker.log has ${tel.client} [client and ${tel.stats} [stats lines — dev telemetry not reaching the Worker (DEV_TELEMETRY=1? /api/dev/log?)`,
    });

  for (const p of input.peers) {
    const add = (severity: Anomaly["severity"], rule: string, detail: string) =>
      out.push({ severity, rule, peer: p.label, detail });
    if (p.crashed) add("hard", "crashed", "page crashed or closed during the run");
    if (!p.hasQaHook)
      add(
        "hard",
        "no-qa-hook",
        "window.__clearcall missing — app not opened with ?qa=1 or hook not installed",
      );
    if (p.connectedMs === null)
      add("hard", "never-connected", `not all ${input.participants - 1} remotes reached connected`);
    else if (p.connectedMs > 10_000)
      add("soft", "slow-connect", `connected after ${(p.connectedMs / 1000).toFixed(1)} s`);
    if (p.firstFrameMs !== null && p.firstFrameMs > 5_000)
      add("soft", "slow-first-frame", `first remote frame after ${(p.firstFrameMs / 1000).toFixed(1)} s`);
    for (const e of p.pageErrors.slice(0, 5))
      add("hard", /^(start|join|inject) .*failed/.test(e) ? "setup-failed" : "page-error", e);

    const errs = p.logs.filter((l) => l.level === "error" && l.t >= input.t0);
    if (errs.length)
      add(
        faulted ? "soft" : "hard",
        "error-log",
        `${errs.length} error-level log entr${errs.length === 1 ? "y" : "ies"}; first: [${errs[0]!.scope}] ${errs[0]!.msg}${faulted ? " (fault injected — may be expected)" : ""}`,
      );

    const tl = p.timeline.filter((s) => s.t >= input.t0);
    if (!tl.length) {
      add("hard", "no-stats", "empty stats timeline");
      continue;
    }
    const sum = summarizeTimeline(tl, 0);
    for (const r of sum.remotes) {
      if (r.freeze_ratio !== null && r.freeze_ratio > 0.01)
        add(
          "soft",
          "freezes",
          `remote ${r.id.slice(0, 6)} frozen ${(r.freeze_ratio * 100).toFixed(1)} % of the time`,
        );
      if (r.concealment_ratio !== null && r.concealment_ratio > 0.03)
        add(
          "soft",
          "audio-concealment",
          `remote ${r.id.slice(0, 6)} concealment ${(r.concealment_ratio * 100).toFixed(1)} %`,
        );
    }
    // Per-connection send rate vs policy target.
    const target = loggedPolicyKbps(p.logs) ?? policyTargetKbps(input.participants);
    for (const id of new Set(tl.flatMap((s) => s.peers.map((x) => x.id)))) {
      const run = longestRun(tl, (s) => {
        const k = s.peers.find((x) => x.id === id)?.outboundKbps;
        return typeof k === "number" && k < 0.5 * target;
      });
      if (run > 10)
        add(
          "soft",
          "low-bitrate",
          `→${id.slice(0, 6)} below 50 % of ${Math.round(target)} kbps target for ${run} s`,
        );
    }
    if (sum.encode_ms_mean !== null && sum.encode_ms_mean > 20)
      add("soft", "slow-encode", `encode ${sum.encode_ms_mean.toFixed(1)} ms/frame (> 20)`);
    if (sum.long_task_ms_per_s !== null && sum.long_task_ms_per_s > 200)
      add("soft", "long-tasks", `main-thread long tasks ${Math.round(sum.long_task_ms_per_s)} ms per second`);
    const failed = tl.at(-1)!.peers.filter((x) => x.connectionState !== "connected");
    if (failed.length)
      add(
        "hard",
        "not-connected-at-end",
        failed.map((x) => `${x.id.slice(0, 6)}=${x.connectionState}`).join(", "),
      );
  }
  return out;
}
