/** Lab report shape, Markdown rendering and report-to-report diffing (compare.ts). */
import type { DnsmosScore, MusicScore, SpeechScore } from "./audio.ts";
import type { TimelineSummary } from "./metrics.ts";
import type { LinkState, LinkStep } from "./profiles.ts";
import type { Evaluation, MetricValue } from "./thresholds.ts";
import type { VmafResult } from "./video.ts";

export type Scored<T> = T | { error: string };

export interface DirectionResult {
  /** Sender → receiver, participant labels (p0, p1…). */
  from: string;
  to: string;
  mode: "voice" | "music";
  video?: Scored<VmafResult>;
  speech?: Scored<SpeechScore>;
  /** PESQ against the clean source when the sent audio was noisy (noise-suppression benefit). */
  speech_vs_clean?: Scored<SpeechScore>;
  dnsmos?: Scored<DnsmosScore>;
  music?: Scored<MusicScore>;
  recording?: string;
}

export interface PeerResult {
  label: string;
  /** Wall ms from clicking Join until every remote is connected / first remote frame decoded. */
  connected_ms: number | null;
  first_frame_ms: number | null;
  /**
   * Joiner-perceived time to first frame: from the LATEST Join click among this participant and the remotes it
   * waits for, to the first decoded frame of every remote (polled from the moment of its own click, 100 ms
   * resolution). Unlike first_frame_ms it excludes the other guests' page loads and serial joins.
   */
  join_ttff_ms?: number | null;
  cpu_pct: number | null;
  summary: TimelineSummary;
}

export interface LabReport {
  schema: 1;
  profile: string;
  started: string;
  finished: string;
  network: { shaping: "netem" | "unshaped"; link: LinkState; schedule: LinkStep[] };
  topology: "p2p" | "mesh";
  participants: number;
  mode: "voice" | "music";
  corpus: { audio: string; video: string; synthetic: boolean };
  duration_s: number;
  app_url: string;
  git: { commit: string; dirty: boolean };
  /** Gate metrics (thresholds keys without _min/_max) plus extra headline numbers. */
  metrics: Record<string, MetricValue>;
  errors: Record<string, string>;
  directions: DirectionResult[];
  peers: PeerResult[];
  evaluation: Evaluation;
  notes: string[];
}

export function isScored<T extends object>(x: Scored<T> | undefined): x is T {
  return !!x && !("error" in x);
}

const fmt = (v: unknown, digits = 2): string => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "—";
    if (Number.isInteger(v)) return String(v);
    return Math.abs(v) < 0.1 ? v.toFixed(4) : v.toFixed(digits);
  }
  return String(v);
};

export function renderMarkdown(r: LabReport): string {
  const L: string[] = [];
  const shaped = r.network.shaping === "netem";
  L.push(`# Quality lab — ${r.profile}${shaped ? "" : " (UNSHAPED)"}`);
  L.push("");
  if (!shaped)
    L.push(
      "> **Unshaped run**: no network impairment was applied (no `--netem`). Only `good_wifi`-like numbers are meaningful; the profile's link values below were NOT enforced.",
      "",
    );
  if (r.evaluation.source === "proposed")
    L.push("> Gates are from **thresholds.proposed.yaml (proposed, not adopted by the owner)**.", "");
  const verdict = r.evaluation.breached ? "**FAIL**" : "**PASS**";
  L.push(`Verdict: ${verdict} (${r.evaluation.source} thresholds)`);
  L.push("");
  L.push(
    `- ${r.started} → ${r.finished} · ${r.duration_s} s · ${r.topology} × ${r.participants} · mode ${r.mode}`,
    `- corpus: audio \`${r.corpus.audio}\`, video \`${r.corpus.video}\`${r.corpus.synthetic ? " (synthetic)" : ""}`,
    `- link: up ${r.network.link.up_kbps} / down ${r.network.link.down_kbps} kbps, delay ${r.network.link.delay_ms} ms ± ${r.network.link.jitter_ms}, loss ${r.network.link.loss_pct} % (${r.network.link.loss_model})${r.network.schedule.length ? `, schedule ${JSON.stringify(r.network.schedule)}` : ""} — ${shaped ? "netem" : "not applied"}`,
    `- app ${r.app_url} · git ${r.git.commit}${r.git.dirty ? " (dirty)" : ""}`,
    "",
  );
  L.push("## Gates", "", "| gate | limit | value | status |", "|---|---|---|---|");
  for (const g of r.evaluation.rows)
    L.push(
      `| ${g.key} | ${g.op} ${fmt(g.limit)} | ${fmt(g.value)} | ${g.status === "pass" ? "pass" : g.status === "fail" ? "**FAIL**" : g.status === "error" ? `**ERROR** ${g.note ?? ""}` : "not measured"} |`,
    );
  L.push("", "## Headline metrics", "", "| metric | value |", "|---|---|");
  for (const [k, v] of Object.entries(r.metrics)) L.push(`| ${k} | ${fmt(v)} |`);

  L.push("", "## Directions (sender → receiver)", "");
  L.push("| dir | VMAF | VMAF p5 | delivered | PESQ-WB | PESQ vs clean | DNSMOS S/B/O | music SNR / LSD |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const d of r.directions) {
    const v = isScored(d.video) ? d.video : null;
    const s = isScored(d.speech) ? d.speech : null;
    const c = isScored(d.speech_vs_clean) ? d.speech_vs_clean : null;
    const n = isScored(d.dnsmos) ? d.dnsmos : null;
    const m = isScored(d.music) ? d.music : null;
    const err = (x: Scored<object> | undefined) => (x && "error" in x ? `error: ${x.error}` : "—");
    L.push(
      `| ${d.from}→${d.to} | ${v ? fmt(v.vmaf_mean) : err(d.video)} | ${v ? fmt(v.vmaf_p5) : "—"} | ${v ? fmt(v.alignment.delivery_ratio) : "—"} | ${s ? fmt(s.pesq_wb) : err(d.speech)} | ${c ? fmt(c.pesq_wb) : "—"} | ${n ? `${fmt(n.sig)}/${fmt(n.bak)}/${fmt(n.ovrl)}` : err(d.dnsmos)} | ${m ? `${fmt(m.snr_db)} dB / ${fmt(m.lsd_db)}` : d.music ? err(d.music) : "—"} |`,
    );
  }
  L.push("", "## Participants", "");
  L.push(
    "| peer | connect ms | 1st frame ms | join→frame ms | send kbps mean/p95 | recv kbps mean/p95 | RTT ms | freeze % | conceal % | enc ms | CPU % | limit |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const p of r.peers) {
    const s = p.summary;
    const ql = Object.entries(
      Object.assign({}, ...s.remotes.map((x) => x.quality_limitation)) as Record<string, number>,
    )
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
    L.push(
      `| ${p.label} | ${fmt(p.connected_ms)} | ${fmt(p.first_frame_ms)} | ${fmt(p.join_ttff_ms ?? null)} | ${fmt(s.send_kbps_mean, 0)}/${fmt(s.send_kbps_p95, 0)} | ${fmt(s.recv_kbps_mean, 0)}/${fmt(s.recv_kbps_p95, 0)} | ${fmt(s.rtt_ms_mean, 0)} | ${fmt(s.freeze_ratio_max === null ? null : s.freeze_ratio_max * 100)} | ${fmt(s.concealment_ratio_max === null ? null : s.concealment_ratio_max * 100)} | ${fmt(s.encode_ms_mean)} | ${fmt(p.cpu_pct, 0)} | ${ql || "—"} |`,
    );
  }
  const attr = r.peers.flatMap((p) => p.summary.remotes.map((x) => ({ p: p.label, x })));
  if (attr.some(({ x }) => x.video_send_kbps !== undefined && x.video_send_kbps !== null)) {
    L.push("", "## Send attribution (per sender → remote, kbps over the window)", "");
    L.push(
      "| sender → remote | video | of which RTX | RTP hdr | audio | enc target | sent fps | keyframes | PLI rx | NACK rx | rx loss % | rx FEC % | rx RTX % |",
    );
    L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    const pc = (v: number | null | undefined) => (v === null || v === undefined ? "—" : fmt(v * 100));
    for (const { p, x } of attr)
      L.push(
        `| ${p} → ${x.id.slice(0, 6)} | ${fmt(x.video_send_kbps, 0)} | ${fmt(x.rtx_send_kbps, 1)} | ${fmt(x.video_header_kbps, 0)} | ${fmt(x.audio_send_kbps, 1)} | ${fmt(x.video_target_kbps_mean, 0)} | ${fmt(x.sent_fps_mean, 1)} | ${fmt(x.keyframes_encoded)} | ${fmt(x.pli_received)} | ${fmt(x.nack_received)} | ${pc(x.video_loss_ratio)} | ${pc(x.fec_recv_ratio)} | ${pc(x.rtx_recv_ratio)} |`,
      );
  }
  if (Object.keys(r.errors).length) {
    L.push("", "## Errors", "");
    for (const [k, v] of Object.entries(r.errors)) L.push(`- **${k}**: ${v}`);
  }
  if (r.notes.length) {
    L.push("", "## Notes", "");
    for (const n of r.notes) L.push(`- ${n}`);
  }
  return `${L.join("\n")}\n`;
}

// ───────────────────────────── diff ─────────────────────────────

type Better = "higher" | "lower";
/** Direction + noise band (absolute, or relative when `rel`). Within the band = "same". */
export const METRIC_SPEC: Record<
  string,
  { better: Better; noise: number; rel?: boolean; quality?: boolean }
> = {
  vmaf: { better: "higher", noise: 1, quality: true },
  vmaf_p5: { better: "higher", noise: 1.5 },
  vmaf_late: { better: "higher", noise: 1 },
  vmaf_thumbnail: { better: "higher", noise: 1, quality: true },
  pesq_wb: { better: "higher", noise: 0.05, quality: true },
  pesq_wb_vs_clean: { better: "higher", noise: 0.05 },
  dnsmos_ovrl: { better: "higher", noise: 0.05, quality: true },
  dnsmos_sig: { better: "higher", noise: 0.05 },
  dnsmos_bak: { better: "higher", noise: 0.05 },
  music_snr_db: { better: "higher", noise: 0.5, quality: true },
  music_lsd_db: { better: "lower", noise: 0.3 },
  delivery_ratio: { better: "higher", noise: 0.01 },
  setup_success_rate: { better: "higher", noise: 0 },
  kbps: { better: "lower", noise: 0.03, rel: true },
  kbps_p95: { better: "lower", noise: 0.05, rel: true },
  audio_kbps: { better: "lower", noise: 0.03, rel: true },
  audio_latency_ms: { better: "lower", noise: 10 },
  audio_mouth_to_ear_ms: { better: "lower", noise: 10 },
  freeze_ratio: { better: "lower", noise: 0.002 },
  audio_concealment_ratio: { better: "lower", noise: 0.002 },
  time_to_first_frame_ms: { better: "lower", noise: 150 },
  rtt_ms: { better: "lower", noise: 10 },
  cpu_pct: { better: "lower", noise: 5 },
  encode_ms: { better: "lower", noise: 0.5 },
  proc_cpu_pct: { better: "lower", noise: 0.1, rel: true },
  proc_cpu_pct_per_peer: { better: "lower", noise: 0.1, rel: true },
  send_kbps: { better: "lower", noise: 0.03, rel: true },
  frame_height: { better: "higher", noise: 10 },
  adapt_down_s: { better: "lower", noise: 1 },
  recover_up_s: { better: "lower", noise: 1 },
};

export interface DiffRow {
  metric: string;
  base: number | null;
  cand: number | null;
  delta: number | null;
  verdict: "better" | "worse" | "same" | "n/a";
}

export interface ReportDiff {
  rows: DiffRow[];
  /** win = better quality at ≤ bandwidth, or equal quality at less bandwidth (quality-lab skill). */
  overall: "win" | "loss" | "trade-off" | "no-change" | "incomparable";
  warnings: string[];
}

export function diffMetric(metric: string, base: MetricValue, cand: MetricValue): DiffRow {
  const spec = METRIC_SPEC[metric];
  const b = typeof base === "number" && Number.isFinite(base) ? base : null;
  const c = typeof cand === "number" && Number.isFinite(cand) ? cand : null;
  if (b === null || c === null || !spec)
    return { metric, base: b, cand: c, delta: b !== null && c !== null ? c - b : null, verdict: "n/a" };
  const delta = c - b;
  const band = spec.rel ? Math.abs(b) * spec.noise : spec.noise;
  if (Math.abs(delta) <= band) return { metric, base: b, cand: c, delta, verdict: "same" };
  const improved = spec.better === "higher" ? delta > 0 : delta < 0;
  return { metric, base: b, cand: c, delta, verdict: improved ? "better" : "worse" };
}

export function diffReports(
  base: Pick<LabReport, "metrics" | "profile" | "network">,
  cand: typeof base,
): ReportDiff {
  const warnings: string[] = [];
  if (base.profile !== cand.profile) warnings.push(`different profiles: ${base.profile} vs ${cand.profile}`);
  if (base.network.shaping !== cand.network.shaping)
    warnings.push(`different shaping: ${base.network.shaping} vs ${cand.network.shaping}`);
  const keys = [...new Set([...Object.keys(base.metrics), ...Object.keys(cand.metrics)])].filter(
    (k) => METRIC_SPEC[k],
  );
  keys.sort((a, b) => Object.keys(METRIC_SPEC).indexOf(a) - Object.keys(METRIC_SPEC).indexOf(b));
  const rows = keys.map((k) => diffMetric(k, base.metrics[k], cand.metrics[k]));
  const quality = rows.filter((r) => METRIC_SPEC[r.metric]?.quality && r.verdict !== "n/a");
  const bw = rows.find((r) => r.metric === "kbps");
  let overall: ReportDiff["overall"];
  if (!quality.length && (!bw || bw.verdict === "n/a")) overall = "incomparable";
  else {
    const qBetter = quality.some((r) => r.verdict === "better");
    const qWorse = quality.some((r) => r.verdict === "worse");
    const bwV = bw?.verdict ?? "n/a";
    const bwNotWorse = bwV !== "worse";
    if (qBetter && !qWorse && bwNotWorse) overall = "win";
    else if (!qBetter && !qWorse && bwV === "better") overall = "win";
    else if (!qBetter && !qWorse && (bwV === "same" || bwV === "n/a")) overall = "no-change";
    else if ((qWorse && !qBetter && bwV !== "better") || (!qBetter && !qWorse && bwV === "worse"))
      overall = "loss";
    else overall = "trade-off";
  }
  if (warnings.length && overall !== "incomparable")
    warnings.push("verdict is unreliable across these differences");
  return { rows, overall, warnings };
}

export function renderDiff(d: ReportDiff, baseLabel: string, candLabel: string): string {
  const L = [
    `# Compare: ${baseLabel} → ${candLabel}`,
    "",
    `Overall: **${d.overall}** (win = better quality at ≤ bandwidth, or equal quality at less bandwidth; noise bands: VMAF ±1, MOS ±0.05, kbps ±3 %)`,
    "",
  ];
  for (const w of d.warnings) L.push(`> warning: ${w}`);
  if (d.warnings.length) L.push("");
  L.push("| metric | base | candidate | Δ | verdict |", "|---|---|---|---|---|");
  for (const r of d.rows)
    L.push(
      `| ${r.metric} | ${fmt(r.base)} | ${fmt(r.cand)} | ${r.delta === null ? "—" : `${r.delta > 0 ? "+" : ""}${fmt(r.delta)}`} | ${r.verdict} |`,
    );
  return `${L.join("\n")}\n`;
}
