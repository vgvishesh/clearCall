/** summary.md for `make diag` bundles (pure). */
import type { Anomaly, DiagInput, FaultSpec } from "./anomalies.ts";
import { countTelemetry } from "./anomalies.ts";
import { summarizeTimeline } from "./metrics.ts";

export interface DiagMeta {
  started: string;
  finished: string;
  url: string;
  durationS: number;
  shaping: string;
  faults: FaultSpec[];
  cpu: Record<string, number | null>;
  dir: string;
}

const f = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? "—" : v.toFixed(d));

export function renderDiagSummary(input: DiagInput, anomalies: Anomaly[], meta: DiagMeta): string {
  const hard = anomalies.filter((a) => a.severity === "hard");
  const soft = anomalies.filter((a) => a.severity === "soft");
  const tel = countTelemetry(input.workerLog);
  const L: string[] = [
    `# Diag — ${input.participants} participants, ${meta.durationS} s`,
    "",
    `Result: ${hard.length ? `**${hard.length} HARD anomal${hard.length === 1 ? "y" : "ies"}**` : "**no hard anomalies**"}, ${soft.length} soft`,
    "",
    `- ${meta.started} → ${meta.finished} · ${meta.url} · network: ${meta.shaping}`,
    `- faults: ${meta.faults.length ? meta.faults.map((x) => `${x.fault}@${x.atS}s by p${x.peer}`).join(", ") : "none"}`,
    `- worker.log: ${tel.client} [client lines, ${tel.stats} [stats lines`,
    "",
    "## Anomalies",
    "",
  ];
  if (!anomalies.length) L.push("None.");
  for (const a of [...hard, ...soft])
    L.push(`- **${a.severity}** \`${a.rule}\`${a.peer ? ` ${a.peer}` : ""}: ${a.detail}`);
  L.push(
    "",
    "## Participants",
    "",
    "| peer | connect ms | 1st frame ms | send kbps mean/p95 | recv kbps mean/p95 | RTT ms | audio lost | freeze % | enc ms/frame | long tasks ms/s | CPU % (main thread) | candidate |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const p of input.peers) {
    const s = summarizeTimeline(
      p.timeline.filter((x) => x.t >= input.t0),
      0,
    );
    const lost = s.remotes.reduce((a, r) => a + (r.audio_packets_lost ?? 0), 0);
    const cand = [...new Set(s.remotes.map((r) => r.candidate_type).filter(Boolean))].join(",") || "—";
    L.push(
      `| ${p.label} | ${f(p.connectedMs)} | ${f(p.firstFrameMs)} | ${f(s.send_kbps_mean)}/${f(s.send_kbps_p95)} | ${f(s.recv_kbps_mean)}/${f(s.recv_kbps_p95)} | ${f(s.rtt_ms_mean)} | ${lost} | ${f(s.freeze_ratio_max === null ? null : s.freeze_ratio_max * 100, 2)} | ${f(s.encode_ms_mean, 1)} | ${f(s.long_task_ms_per_s)} | ${f(meta.cpu[p.label])} | ${cand} |`,
    );
  }
  L.push(
    "",
    "## Files",
    "",
    "- `peer-<i>/logs.json` QA structured logs · `peer-<i>/timeline.json` 1 Hz stats · `peer-<i>/console.txt` console + page errors + failed requests · `peer-<i>/screenshot.png`",
    "- `cpu.json` main-thread task time per browser (CDP) · `worker.log` dev-server.log slice for this run · `summary.json` machine-readable",
    "",
  );
  return L.join("\n");
}
