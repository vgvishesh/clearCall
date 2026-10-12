/**
 * Quality lab runner.
 *
 *   pnpm --filter @clearcall/quality lab --profile <name|all> [--netem] [--url http://localhost:8787]
 *        [--duration <s>] [--no-voice-baseline] [--keep-work] [--flags "abr=40000&ns=0"] [--tag <label>]
 *        [--participants N] [--shared-browser] [--viewport 390x844@3] [--latency] [--emulate-loss 5]
 *   pnpm --filter @clearcall/quality lab --selftest [--seconds 20] [--kbps 1000] [--rec-kbps 8000] [--vcodec vp9] (no app needed)
 *
 * Per profile: N headless Chromium participants (one browser each) fed with reference media
 * (--use-file-for-fake-*-capture), driven through the UI testids with `?qa=1`; received media is recorded via the
 * QA hook; the 1 Hz stats timeline is collected from every participant; then VMAF (frame-ID aligned), PESQ-WB,
 * DNSMOS and music fidelity are scored and gated against thresholds.yaml (else thresholds.proposed.yaml — labelled
 * "proposed"). Output: quality/reports/<ts>-<profile>/report.{json,md} + recordings + per-peer timelines/logs.
 * Exit 1 on any breach or session error. Without --netem the run is labelled UNSHAPED.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import { dnsmos, scoreMusic, scoreSpeech } from "./audio.ts";
import {
  type Envelope,
  envelopeLatency,
  type LatencyResult,
  startEnvelope,
  stopEnvelope,
} from "./latency.ts";
import { lossEmulation, lossEmuStats } from "./loss-emu.ts";
import {
  adaptTimes,
  maxOrNull,
  mean,
  type QaStatsSample,
  sendLevelSummary,
  sendSeries,
  summarizeTimeline,
} from "./metrics.ts";
import {
  containerAppUrl,
  containerMediaPath,
  dockerAvailable,
  ensureImage,
  ensureNetwork,
  type PeerContainer,
  startPeerContainer,
  stopPeerContainers,
  updateLink,
} from "./netem.ts";
import { browserCpu, cpuPct, cpuPctBetween, launchSharedBrowser, Peer, parseViewport } from "./peers.ts";
import { corpusFile, type MediaManifest, prepareMedia } from "./prepare-media.ts";
import { changePoints, linkAt, listProfiles, loadProfile, type Profile } from "./profiles.ts";
import {
  type DirectionResult,
  isScored,
  type LabReport,
  type PeerResult,
  renderMarkdown,
  type Scored,
} from "./report.ts";
import { evaluate, gatesFor, loadThresholds, type MetricValue } from "./thresholds.ts";
import { CACHE_DIR, ensureDir, log, parseArgs, REPORTS_DIR, ROOT_DIR, run, timestamp } from "./util.ts";
import { scoreVideo } from "./video.ts";

/** Above this many participants the lab uses one shared Chromium (host limit: never > 6 browser processes). */
export const MAX_BROWSERS = 5;

export interface LabOptions {
  appUrl: string;
  netem: boolean;
  durationOverride?: number;
  voiceBaseline: boolean;
  keepWork: boolean;
  /** App URL flags for every participant (variant forcing, e.g. "red=1" or "abr=40000&dtx=0"). */
  flags?: string;
  /** Suffix for the report directory name (<ts>-<profile>-<tag>). */
  tag?: string;
  /** Override the profile's participant count (codec/policy tiers). */
  participantsOverride?: number;
  /** One Chromium with N contexts (forced on above MAX_BROWSERS; netem always uses one browser per container). */
  sharedBrowser?: boolean;
  /** Participant page viewport, e.g. "390x844@3" (phone portrait); default 960×600 @1. */
  viewport?: string;
  /** Run the audio latency probe (envelope correlation, src/latency.ts). */
  latency?: boolean;
  /** Emulate this % of Gilbert audio loss in the receivers when netem is unavailable (src/loss-emu.ts). */
  emulateLoss?: number;
}

export interface SessionResult {
  started: Date;
  finished: Date;
  peers: PeerResult[];
  directions: DirectionResult[];
  timelines: Record<string, QaStatsSample[]>;
  errors: Record<string, string>;
  notes: string[];
  t0: number;
  /** Whole-tree CPU of all local browsers during the measure window (% of one core). */
  proc_cpu_pct?: number | null;
  /** Audio capture→playout latency per direction ("p1_to_p0"), when --latency. */
  latency?: Record<string, LatencyResult | null>;
}

export const errMsg = (e: unknown) =>
  e instanceof Error
    ? e.message
        .split("\n")
        .filter((l) => l.trim() && !l.includes("Call log"))
        .slice(0, 2)
        .join(" — ")
        .replace(/\s+/g, " ")
    : String(e);

async function scored<T>(f: () => Promise<T>): Promise<Scored<T>> {
  try {
    return await f();
  } catch (e) {
    return { error: errMsg(e) };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One call session: launch, join, (shape), record, collect. Never throws — failures land in `errors`. */
export async function runSession(
  profile: Profile,
  mode: "voice" | "music",
  media: MediaManifest,
  opts: LabOptions,
  outDir: string,
): Promise<SessionResult> {
  const started = new Date();
  const errors: Record<string, string> = {};
  const notes: string[] = [];
  const n = profile.participants;
  const duration = opts.durationOverride ?? profile.duration_s;
  const videoRef = corpusFile(profile.video, media);
  const audioRef = corpusFile(profile.audio, media);
  const suffix = mode === profile.mode ? "" : `-${mode}`;
  const peers: Peer[] = [];
  let shared: Browser | null = null;
  const containers: PeerContainer[] = [];
  const timers: NodeJS.Timeout[] = [];
  const results: PeerResult[] = [];
  const directions: DirectionResult[] = [];
  const timelines: Record<string, QaStatsSample[]> = {};
  const latency: Record<string, LatencyResult | null> = {};
  let t0 = Date.now();
  let procCpuPct: number | null = null;
  try {
    // ── launch ──
    let appUrl = opts.appUrl;
    let extraArgs: string[] = [];
    let mediaPaths = { video: videoRef, audio: audioRef };
    if (opts.netem) {
      await ensureImage();
      await ensureNetwork();
      const c = containerAppUrl(opts.appUrl);
      appUrl = c.url;
      extraArgs = c.args;
      mediaPaths = { video: containerMediaPath(videoRef), audio: containerMediaPath(audioRef) };
      for (let i = 0; i < n; i++) containers.push(await startPeerContainer(i, linkAt(profile, 0)));
      if (containers.some((c) => !c.ingressShaped))
        notes.push(
          "downlink (down_kbps) NOT shaped: ifb unavailable in the Docker VM kernel; uplink shaping only",
        );
    }
    const emu = opts.emulateLoss ? lossEmulation(opts.emulateLoss, profile.seed) : null;
    if (emu) {
      extraArgs = [...extraArgs, ...emu.chromiumArgs];
      notes.push(emu.note);
    }
    const useShared = !opts.netem && (opts.sharedBrowser || n > MAX_BROWSERS);
    log(
      `launching ${n} participants (${opts.netem ? "netem containers" : "local, unshaped"}, ${mode} mode${useShared ? ", one shared browser" : ""})`,
    );
    if (useShared) {
      shared = await launchSharedBrowser(mediaPaths, extraArgs);
      notes.push(`one shared Chromium with ${n} contexts (host browser-process limit)`);
    }
    for (let i = 0; i < n; i++)
      peers.push(
        await Peer.launch({
          label: `p${i}`,
          name: `P${i}`,
          media: mediaPaths,
          extraArgs,
          ...(opts.flags ? { flags: opts.flags } : {}),
          ...(parseViewport(opts.viewport) ? { viewport: parseViewport(opts.viewport)! } : {}),
          ...(shared ? { browser: shared } : {}),
          ...(emu ? { initScript: emu.initScript, bypassCSP: true } : {}),
          ...(containers[i] ? { wsEndpoint: containers[i]!.wsEndpoint } : {}),
        }),
      );

    // ── join ──
    const [host, ...guests] = peers;
    const link = await host!.startCall(appUrl);
    for (const g of guests) await g.joinCall(link, appUrl);
    const connected = await Promise.all(
      peers.map((p) =>
        p.waitConnected(n, 30_000 + 3_000 * n).catch((e) => {
          errors[`connect_${p.label}`] = errMsg(e);
          return null;
        }),
      ),
    );
    const firstFrames = await Promise.all(peers.map((p) => p.waitFirstFrames(30_000).catch(() => null)));
    if (mode === "music")
      for (const p of peers)
        await p.setMusicMode().catch((e) => {
          errors[`music_mode_${p.label}`] = errMsg(e);
        });

    // ── measure ──
    t0 = Date.now();
    const cpu0 = await Promise.all(peers.map((p) => p.cpuMetrics()));
    const proc0 = await browserCpu();
    for (const at of changePoints(profile))
      timers.push(
        setTimeout(() => {
          log(`t=${at}s link → ${JSON.stringify(linkAt(profile, at))}`);
          for (const c of containers) void updateLink(c, linkAt(profile, at)).catch(() => {});
        }, at * 1000),
      );
    if (!opts.netem && profile.schedule.length) notes.push("link schedule NOT applied (unshaped run)");

    // Directions p1→p0 and p0→p1 (in a mesh the other pairs are covered by stats only).
    const pairs: { from: Peer; to: Peer; remoteId: string }[] = [];
    for (const [rx, tx] of [
      [0, 1],
      [1, 0],
    ] as const) {
      const remotes = (await peers[rx]!.state()).participants;
      const id = remotes.find((r) => r.name === peers[tx]!.name)?.id;
      if (id) pairs.push({ from: peers[tx]!, to: peers[rx]!, remoteId: id });
      else errors[`recording_p${tx}_to_p${rx}`] = `p${rx} has no participant named ${peers[tx]!.name}`;
    }
    for (const pr of pairs)
      await pr.to.startRecording(pr.remoteId).catch((e) => {
        errors[`recording_${pr.from.label}_to_${pr.to.label}`] = errMsg(e);
      });

    if (opts.latency)
      for (const pr of pairs) {
        const key = `${pr.from.label}_to_${pr.to.label}`;
        await startEnvelope(pr.from.page, `tx-${key}`, "local").catch((e) => {
          errors[`latency_${key}`] = errMsg(e);
        });
        await startEnvelope(pr.to.page, `rx-${key}`, pr.remoteId).catch((e) => {
          errors[`latency_${key}`] = errMsg(e);
        });
      }
    log(`measuring for ${duration} s`);
    const end = t0 + duration * 1000;
    while (Date.now() < end) {
      await sleep(Math.min(5000, end - Date.now()));
      for (const p of peers) if (p.page.isClosed()) throw new Error(`${p.label} page closed/crashed`);
    }
    const cpu1 = await Promise.all(peers.map((p) => p.cpuMetrics()));
    procCpuPct = cpuPctBetween(proc0, await browserCpu());

    // ── collect ──
    if (opts.latency)
      for (const pr of pairs) {
        const key = `${pr.from.label}_to_${pr.to.label}`;
        const tx = await stopEnvelope(pr.from.page, `tx-${key}`);
        const rx = await stopEnvelope(pr.to.page, `rx-${key}`);
        if (tx && rx)
          writeFileSync(join(outDir, `envelopes-${key}${suffix}.json`), JSON.stringify({ tx, rx }));
        latency[key] = tx && rx ? envelopeLatency(tx as Envelope, rx as Envelope) : null;
        if (!latency[key]) errors[`latency_${key}`] ??= "no envelope correlation";
      }
    for (const pr of pairs) {
      const key = `${pr.from.label}_to_${pr.to.label}`;
      const buf = await pr.to.stopRecording(pr.remoteId).catch((e) => {
        errors[`recording_${key}`] = errMsg(e);
        return null;
      });
      const dir: DirectionResult = { from: pr.from.label, to: pr.to.label, mode };
      if (buf) {
        dir.recording = join(outDir, `rec-${key}${suffix}.webm`);
        writeFileSync(dir.recording, buf);
      } else errors[`recording_${key}`] ??= "empty recording";
      directions.push(dir);
    }
    if (emu)
      for (const p of peers) {
        const st = await lossEmuStats(p.page);
        if (!st || st.error || !st.frames)
          errors[`loss_emulation_${p.label}`] = st?.error ?? "no frames seen";
        else
          notes.push(
            `${p.label}: emulated audio loss ${((100 * st.dropped) / st.frames).toFixed(2)} % (${st.dropped}/${st.frames} frames)`,
          );
      }
    for (const [i, p] of peers.entries()) {
      const pd = ensureDir(join(outDir, `${p.label}${suffix}`));
      const tl = await p.timeline();
      timelines[p.label] = tl;
      writeFileSync(join(pd, "timeline.json"), JSON.stringify(tl));
      writeFileSync(join(pd, "logs.json"), JSON.stringify(await p.logs(), null, 1));
      writeFileSync(
        join(pd, "console.txt"),
        p.console.map((c) => `${new Date(c.t).toISOString()} ${c.type} ${c.text}`).join("\n"),
      );
      await p.screenshot(join(pd, "screenshot.png"));
      if (p.pageErrors.length) errors[`page_errors_${p.label}`] = p.pageErrors.slice(0, 3).join(" | ");
      results.push({
        label: p.label,
        connected_ms: connected[i] ?? null,
        first_frame_ms: firstFrames[i] ?? null,
        cpu_pct: cpuPct(cpu0[i] ?? null, cpu1[i] ?? null),
        summary: summarizeTimeline(tl.filter((s) => s.t >= t0)),
      });
      if (!tl.length) notes.push(`${p.label}: empty stats timeline`);
    }
  } catch (e) {
    errors.session = errMsg(e);
    for (const p of peers) {
      const pd = ensureDir(join(outDir, `${p.label}${suffix}`));
      await p.screenshot(join(pd, "screenshot.png"));
      writeFileSync(join(pd, "console.txt"), p.console.map((c) => `${c.type} ${c.text}`).join("\n"));
    }
  } finally {
    for (const t of timers) clearTimeout(t);
    await Promise.all(peers.map((p) => p.close()));
    await shared?.close().catch(() => {});
    if (containers.length) await stopPeerContainers(containers);
  }
  return {
    started,
    finished: new Date(),
    peers: results,
    directions,
    timelines,
    errors,
    notes,
    t0,
    proc_cpu_pct: procCpuPct,
    ...(opts.latency ? { latency } : {}),
  };
}

export async function scoreDirections(
  dirs: DirectionResult[],
  profile: Profile,
  media: MediaManifest,
  workDir: string,
): Promise<void> {
  const videoRef = corpusFile(profile.video, media);
  const audioRef = corpusFile(profile.audio, media);
  const clean = media.cleanOf[profile.audio];
  for (const d of dirs) {
    if (!d.recording) continue;
    const rec = d.recording;
    const w = join(workDir, `${d.from}_to_${d.to}_${d.mode}`);
    log(`scoring ${d.from}→${d.to} (${d.mode})`);
    d.video = await scored(() => scoreVideo(videoRef, rec, join(w, "video")));
    if (profile.audio === "music") d.music = await scored(() => scoreMusic(audioRef, rec, join(w, "music")));
    else {
      d.speech = await scored(() => scoreSpeech(audioRef, rec, join(w, "speech")));
      if (clean)
        d.speech_vs_clean = await scored(() => scoreSpeech(corpusFile(clean, media), rec, join(w, "clean")));
      d.dnsmos = await scored(() => dnsmos(rec, join(w, "dnsmos")));
    }
  }
}

/** Aggregate session results into gate metrics (worst direction / worst participant). Pure. */
export function buildMetrics(
  profile: Profile,
  s: Pick<SessionResult, "peers" | "directions" | "t0" | "timelines" | "proc_cpu_pct">,
): { metrics: Record<string, MetricValue>; errors: Record<string, string> } {
  const m: Record<string, MetricValue> = {};
  const errors: Record<string, string> = {};
  const dirs = s.directions.filter((d) => d.mode === profile.mode);
  const pick = <T extends object>(
    get: (d: DirectionResult) => Scored<T> | undefined,
    metric: string,
    value: (x: T) => number,
    agg: "min" | "max",
  ) => {
    const attempted = dirs.map(get).filter((x): x is Scored<T> => x !== undefined);
    const ok = attempted.filter(isScored).map(value);
    if (ok.length) m[metric] = agg === "min" ? Math.min(...ok) : Math.max(...ok);
    else if (attempted.length) errors[metric] = (attempted[0] as { error: string }).error;
  };
  pick(
    (d) => d.video,
    "vmaf",
    (v) => v.vmaf_mean,
    "min",
  );
  pick(
    (d) => d.video,
    "vmaf_p5",
    (v) => v.vmaf_p5,
    "min",
  );
  pick(
    (d) => d.video,
    "vmaf_late",
    (v) => v.vmaf_late,
    "min",
  );
  pick(
    (d) => d.video,
    "delivery_ratio",
    (v) => v.alignment.delivery_ratio,
    "min",
  );
  pick(
    (d) => d.speech,
    "pesq_wb",
    (v) => v.pesq_wb,
    "min",
  );
  pick(
    (d) => d.speech_vs_clean,
    "pesq_wb_vs_clean",
    (v) => v.pesq_wb,
    "min",
  );
  pick(
    (d) => d.dnsmos,
    "dnsmos_ovrl",
    (v) => v.ovrl,
    "min",
  );
  pick(
    (d) => d.dnsmos,
    "dnsmos_sig",
    (v) => v.sig,
    "min",
  );
  pick(
    (d) => d.dnsmos,
    "dnsmos_bak",
    (v) => v.bak,
    "min",
  );
  pick(
    (d) => d.music,
    "music_snr_db",
    (v) => v.snr_db,
    "min",
  );
  pick(
    (d) => d.music,
    "music_lsd_db",
    (v) => v.lsd_db,
    "max",
  );
  if (profile.participants > 4) {
    if (m.vmaf !== undefined) m.vmaf_thumbnail = m.vmaf;
    if (errors.vmaf) errors.vmaf_thumbnail = errors.vmaf;
  }

  const P = s.peers;
  if (P.length) {
    m.kbps = maxOrNull(P.map((p) => p.summary.total_kbps_mean));
    m.kbps_p95 = maxOrNull(P.map((p) => p.summary.total_kbps_p95));
    m.send_kbps = maxOrNull(P.map((p) => p.summary.send_kbps_mean));
    m.audio_kbps = maxOrNull(P.map((p) => maxOrNull(p.summary.remotes.map((r) => r.audio_send_kbps))));
    m.freeze_ratio = maxOrNull(P.map((p) => p.summary.freeze_ratio_max));
    m.audio_concealment_ratio = maxOrNull(P.map((p) => p.summary.concealment_ratio_max));
    m.time_to_first_frame_ms = maxOrNull(P.map((p) => p.first_frame_ms));
    m.cpu_pct = maxOrNull(P.map((p) => p.cpu_pct));
    m.rtt_ms = mean(P.map((p) => p.summary.rtt_ms_mean).filter((x): x is number => x !== null));
    m.encode_ms = maxOrNull(P.map((p) => p.summary.encode_ms_mean));
    // Received resolution: the worst remote anyone decodes (mesh tiers scale per receiver view).
    const heights = P.flatMap((p) => p.summary.remotes.map((r) => r.frame_height_mean)).filter(
      (h): h is number => typeof h === "number",
    );
    if (heights.length) m.frame_height = Math.min(...heights);
    if (s.proc_cpu_pct !== undefined && s.proc_cpu_pct !== null) {
      m.proc_cpu_pct = s.proc_cpu_pct;
      m.proc_cpu_pct_per_peer = s.proc_cpu_pct / P.length;
    }
  }
  m.setup_success_rate = P.filter((p) => p.connected_ms !== null).length / profile.participants;
  const lv = sendLevelSummary(s.timelines, s.t0);
  if (lv.high_ratio !== null) {
    m.send_level_high_ratio = lv.high_ratio;
    m.send_level_high_ratio_late = lv.high_ratio_late;
    m.send_level_first_high_s = lv.first_high_s;
    m.send_level_changes_max = lv.changes_max;
  }

  // bw_squeeze: uplink drop then recovery, measured on p0's send rate.
  const cps = changePoints(profile);
  const tl = s.timelines.p0;
  if (cps.length >= 2 && tl?.length) {
    const [drop, up] = cps as [number, number];
    const a = adaptTimes(sendSeries(tl, s.t0), drop, up, linkAt(profile, drop).up_kbps);
    m.adapt_down_s = a.adapt_down_s;
    m.recover_up_s = a.recover_up_s;
  }
  return { metrics: m, errors };
}

async function gitInfo(): Promise<{ commit: string; dirty: boolean }> {
  const c = await run("git", ["-C", ROOT_DIR, "rev-parse", "--short", "HEAD"], { allowFail: true });
  const d = await run("git", ["-C", ROOT_DIR, "status", "--porcelain"], { allowFail: true });
  return { commit: c.stdout.trim() || "unknown", dirty: d.stdout.trim().length > 0 };
}

export async function runProfile(name: string, opts: LabOptions): Promise<LabReport> {
  const loaded = loadProfile(name);
  const n = opts.participantsOverride ?? loaded.participants;
  const profile: Profile = { ...loaded, participants: n, topology: n > 2 ? "mesh" : loaded.topology };
  const thresholds = loadThresholds();
  const media = await prepareMedia();
  const ts = timestamp();
  const outDir = ensureDir(join(REPORTS_DIR, `${ts}-${name}${opts.tag ? `-${opts.tag}` : ""}`));
  const workDir = join(CACHE_DIR, "work", `${ts}-${name}`);
  log(`profile ${name} → ${outDir} (${thresholds.source} thresholds)`);
  if (opts.netem) {
    const d = await dockerAvailable();
    if (!d.ok) throw new Error(`--netem: ${d.why}`);
  }

  const s = await runSession(profile, profile.mode, media, opts, outDir);
  const notes = [...s.notes];
  if (opts.flags) notes.push(`app URL flags: ${opts.flags}`);
  const errors = { ...s.errors };
  await scoreDirections(s.directions, profile, media, workDir);
  const { metrics, errors: scoreErrors } = buildMetrics(profile, s);
  Object.assign(errors, scoreErrors);

  // Music mode must beat voice mode on the music corpus (second session in voice mode).
  if (gatesFor(thresholds, name).music_mode_better_than_voice !== undefined && profile.mode === "music") {
    if (!opts.voiceBaseline)
      notes.push("voice baseline skipped (--no-voice-baseline): music_mode_better_than_voice not measured");
    else if (!errors.session) {
      log("voice-mode baseline session for music_mode_better_than_voice");
      const v = await runSession(profile, "voice", media, opts, outDir);
      for (const [k, e] of Object.entries(v.errors)) errors[`voice_baseline_${k}`] = e;
      await scoreDirections(v.directions, profile, media, workDir);
      s.directions.push(...v.directions);
      const vm = v.directions.map((d) => d.music).filter(isScored);
      const voiceSnr = vm.length ? Math.min(...vm.map((x) => x.snr_db)) : null;
      metrics.voice_music_snr_db = voiceSnr;
      const ms = metrics.music_snr_db;
      if (voiceSnr !== null && typeof ms === "number")
        metrics.music_mode_better_than_voice = ms > voiceSnr + 0.5;
      else errors.music_mode_better_than_voice = "music or voice-mode music score missing";
    }
  }
  if (s.latency) {
    const ok = Object.entries(s.latency).filter(
      (e): e is [string, LatencyResult] => !!e[1] && e[1].corr >= 0.5,
    );
    if (ok.length) {
      metrics.audio_latency_ms = Math.max(...ok.map(([, r]) => r.latency_ms));
      // thresholds: mouth-to-ear EXCLUDING the profile's configured one-way network delay (applied only with --netem)
      metrics.audio_mouth_to_ear_ms = metrics.audio_latency_ms - (opts.netem ? profile.link.delay_ms : 0);
    } else errors.audio_mouth_to_ear_ms = "latency probe: no trustworthy correlation (corr < 0.5)";
    for (const [k, r] of Object.entries(s.latency))
      if (r)
        notes.push(
          `latency ${k}: ${r.latency_ms.toFixed(1)} ms (corr ${r.corr.toFixed(2)}; 10 s windows ${r.windows.map((w) => w.toFixed(0)).join("/")})`,
        );
    notes.push(
      "audio latency = capture (after APM) → remote playout input, envelope cross-correlation on a shared clock; excludes physical mic/speaker buffers",
    );
  }
  if (errors.session) {
    // Nothing meaningful was measured: every unmeasured gate becomes an error so the run fails loudly.
    for (const k of Object.keys(gatesFor(thresholds, name))) {
      const metric = k.replace(/_(min|max)$/, "");
      if (metrics[metric] === undefined || metrics[metric] === null)
        errors[metric] ??= `session failed: ${errors.session}`;
    }
  }
  if (!opts.latency) notes.push("audio_mouth_to_ear_ms not measured (run with --latency)");
  notes.push(
    "cpu_pct = renderer main-thread task time (CDP TaskDuration) as % of one core, not whole-process CPU",
  );
  if (profile.participants > 2)
    notes.push("media is scored for the p0⇄p1 pair only; other pairs are covered by stats");
  if (opts.viewport) notes.push(`viewport ${opts.viewport}`);
  if (opts.participantsOverride !== undefined && opts.participantsOverride !== loaded.participants)
    notes.push(`participants overridden: ${loaded.participants} → ${n}`);
  if (media.synthetic)
    notes.push(
      "synthetic corpus (prepare-media); owner media in reference-media/<corpus>.{wav,y4m} is used when present",
    );
  if (profile.audio === "speech_noisy")
    notes.push(
      "pesq_wb is against the sent (noisy) signal; pesq_wb_vs_clean is against the clean source (noise-suppression benefit)",
    );

  const evaluation = evaluate(thresholds, name, metrics, errors);
  const report: LabReport = {
    schema: 1,
    profile: name,
    started: s.started.toISOString(),
    finished: new Date().toISOString(),
    network: { shaping: opts.netem ? "netem" : "unshaped", link: profile.link, schedule: profile.schedule },
    topology: profile.topology,
    participants: profile.participants,
    mode: profile.mode,
    corpus: { audio: profile.audio, video: profile.video, synthetic: media.synthetic },
    duration_s: opts.durationOverride ?? profile.duration_s,
    app_url: opts.appUrl,
    git: await gitInfo(),
    metrics,
    errors,
    directions: s.directions,
    peers: s.peers,
    evaluation,
    notes,
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "report.md"), renderMarkdown(report));
  if (!opts.keepWork) await run("rm", ["-rf", workDir], { allowFail: true });
  log(`${evaluation.breached ? "FAIL" : "PASS"} ${name} → ${join(outDir, "report.md")}`);
  return report;
}

export function appUrlFrom(a: ReturnType<typeof parseArgs>): string {
  return (
    a.get("url") ??
    process.env.CLEARCALL_URL ??
    `http://localhost:${process.env.DEV_PORT ?? 8787}`
  ).replace(/\/$/, "");
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.has("selftest")) {
    const { selftest } = await import("./selftest.ts");
    process.exit(
      await selftest({
        seconds: Number(a.get("seconds") ?? 20),
        kbps: Number(a.get("kbps") ?? 1000),
        appUrl: appUrlFrom(a),
        ...(a.get("rec-kbps") ? { recKbps: Number(a.get("rec-kbps")) } : {}),
        ...(a.get("vcodec") ? { vcodec: a.get("vcodec") } : {}),
        ...(a.get("scale") ? { scale: Number(a.get("scale")) } : {}),
        ...(a.get("fps") ? { fps: Number(a.get("fps")) } : {}),
        ...(a.get("warmup") ? { warmup: Number(a.get("warmup")) } : {}),
      }),
    );
  }
  const which = a.get("profile") ?? a.positional[0];
  if (!which) {
    console.error(
      `usage: lab --profile <${listProfiles().join("|")}|all> [--netem] [--url …] [--duration s]`,
    );
    process.exit(2);
  }
  const opts: LabOptions = {
    appUrl: appUrlFrom(a),
    netem: a.has("netem"),
    voiceBaseline: !a.has("no-voice-baseline"),
    keepWork: a.has("keep-work"),
    ...(a.get("flags") ? { flags: a.get("flags")! } : {}),
    ...(a.get("tag") ? { tag: a.get("tag")! } : {}),
    latency: a.has("latency"),
    ...(a.get("emulate-loss") ? { emulateLoss: Number(a.get("emulate-loss")) } : {}),
    ...(a.get("duration") ? { durationOverride: Number(a.get("duration")) } : {}),
    ...(a.get("participants") ? { participantsOverride: Number(a.get("participants")) } : {}),
    ...(a.has("shared-browser") ? { sharedBrowser: true } : {}),
    ...(a.get("viewport") ? { viewport: a.get("viewport")! } : {}),
  };
  if (!opts.netem) log("UNSHAPED run (no --netem): network profile values are not enforced");
  const names = which === "all" ? listProfiles() : [which];
  let breached = false;
  for (const n of names) {
    try {
      const r = await runProfile(n, opts);
      breached ||= r.evaluation.breached;
    } catch (e) {
      console.error(`${n}: ${errMsg(e)}`);
      breached = true;
    }
  }
  process.exit(breached ? 1 : 0);
}

// Keep `readFileSync` referenced for tooling that inspects report dirs from the REPL.
export const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

if (import.meta.url === `file://${process.argv[1]}`) void main();
