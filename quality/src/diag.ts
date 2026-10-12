/**
 * Debug bundle: N headless participants (fake devices, one browser each) join one call on the running dev stack,
 * run DURATION seconds (optionally injecting faults), then everything an agent needs to debug is written to
 * quality/reports/diag-<ts>/ with an anomaly summary. Exit 1 on hard anomalies, 2 on setup problems.
 *
 *   make diag N=4 DURATION=60 ARGS="--fault drop-signaling@20s"
 *   pnpm --filter @clearcall/quality exec tsx src/diag.ts N=4 DURATION=60 [--url …] [--fault spec]…
 *        [--netem --profile 4g_typical]
 * Also: [--flags "vcodec=vp8"] (app URL flags for every peer). N > 5 runs in one shared Chromium (host limit).
 * ramp.json: per stream time-to-target resolution/bitrate after join and overshoot (src/ramp.ts).
 * Fault spec: <drop-signaling|restart-ice|kill-peer>@<seconds>[:p<index>] (restart-ice/kill-peer target the
 * injecting peer's first remote).
 */
import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import {
  type Anomaly,
  type DiagInput,
  type FaultSpec,
  findAnomalies,
  type PeerEvidence,
  parseFault,
} from "./anomalies.ts";
import { renderDiagSummary } from "./diag-report.ts";
import { MAX_BROWSERS } from "./lab.ts";
import {
  containerAppUrl,
  dockerAvailable,
  ensureImage,
  ensureNetwork,
  type PeerContainer,
  startPeerContainer,
  stopPeerContainers,
} from "./netem.ts";
import { browserCpu, cpuPct, cpuPctBetween, launchSharedBrowser, Peer } from "./peers.ts";
import { linkAt, loadProfile } from "./profiles.ts";
import { type RampResult, rampFor, worstRamp } from "./ramp.ts";
import { DEV_LOG, ensureDir, log, parseArgs, REPORTS_DIR, timestamp } from "./util.ts";

const errMsg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0]! : String(e));

function readFrom(file: string, offset: number): string {
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  if (size <= offset) return "";
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const n = Number(a.get("n") ?? 4);
  const duration = Number(a.get("duration") ?? 60);
  const url = (
    a.get("url") ??
    process.env.CLEARCALL_URL ??
    `http://localhost:${process.env.DEV_PORT ?? 8787}`
  ).replace(/\/$/, "");
  const faults: FaultSpec[] = a.all("fault").map(parseFault);
  if (!(n >= 2 && n <= 11) || !(duration > 0)) {
    console.error("N must be 2..11 and DURATION > 0");
    return 2;
  }
  for (const f of faults) if (f.peer >= n) throw new Error(`fault peer p${f.peer} ≥ N`);
  const health = await fetch(`${url}/api/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`dev stack not reachable at ${url}/api/health — run \`make dev\` (or pass --url)`);
    return 2;
  }

  const dir = ensureDir(join(REPORTS_DIR, `diag-${timestamp()}`));
  const devLogOffset = existsSync(DEV_LOG) ? statSync(DEV_LOG).size : 0;
  const started = new Date();
  log(`diag: ${n} participants, ${duration} s → ${dir}`);

  let shaping = "unshaped (local)";
  const containers: PeerContainer[] = [];
  let appUrl = url;
  let extraArgs: string[] = [];
  if (a.has("netem")) {
    const d = await dockerAvailable();
    if (!d.ok) {
      console.error(`--netem: ${d.why}`);
      return 2;
    }
    const profile = loadProfile(a.get("profile") ?? "4g_typical");
    await ensureImage();
    await ensureNetwork();
    const c = containerAppUrl(url);
    appUrl = c.url;
    extraArgs = c.args;
    for (let i = 0; i < n; i++) containers.push(await startPeerContainer(i, linkAt(profile, 0), url));
    shaping = `netem ${profile.name}${containers.some((x) => !x.ingressShaped) ? " (uplink only)" : ""}`;
  }

  const flags = a.get("flags") ?? "";
  const peers: Peer[] = [];
  let shared: Browser | null = null;
  const ramps: Record<string, RampResult[]> = {};
  let procCpuPct: number | null = null;
  const evidence: PeerEvidence[] = [];
  const cpu: Record<string, number | null> = {};
  let t0 = Date.now();
  const timers: NodeJS.Timeout[] = [];
  try {
    if (!containers.length && n > MAX_BROWSERS) {
      shared = await launchSharedBrowser(undefined, extraArgs);
      log(`one shared Chromium with ${n} contexts (host browser-process limit)`);
    }
    for (let i = 0; i < n; i++)
      peers.push(
        await Peer.launch({
          label: `peer-${i}`,
          name: `Diag ${i}`,
          extraArgs,
          flags,
          ...(shared ? { browser: shared } : {}),
          ...(containers[i] ? { wsEndpoint: containers[i]!.wsEndpoint } : {}),
        }),
      );
    const connected: (number | null)[] = new Array(n).fill(null);
    const firstFrames: (number | null)[] = new Array(n).fill(null);
    try {
      const link = await peers[0]!.startCall(appUrl);
      for (const p of peers.slice(1))
        await p.joinCall(link, appUrl).catch((e) => p.pageErrors.push(`join failed: ${errMsg(e)}`));
      await Promise.all(
        peers.map(async (p, i) => {
          connected[i] = await p.waitConnected(n, 30_000 + 3_000 * n).catch(() => null);
          firstFrames[i] = await p.waitFirstFrames(15_000).catch(() => null);
        }),
      );
    } catch (e) {
      peers[0]!.pageErrors.push(`start failed: ${errMsg(e)}`);
    }

    t0 = Date.now();
    const cpu0 = await Promise.all(peers.map((p) => p.cpuMetrics()));
    const proc0 = await browserCpu();
    for (const f of faults)
      timers.push(
        setTimeout(async () => {
          const p = peers[f.peer]!;
          try {
            const target = f.fault === "drop-signaling" ? undefined : (await p.state()).participants[0]?.id;
            log(`t=${f.atS}s inject ${f.fault} on ${p.label}${target ? ` → ${target.slice(0, 6)}` : ""}`);
            await p.inject(f.fault, target);
          } catch (e) {
            p.pageErrors.push(`inject ${f.fault} failed: ${errMsg(e)}`);
          }
        }, f.atS * 1000),
      );
    const end = t0 + duration * 1000;
    while (Date.now() < end) await new Promise((r) => setTimeout(r, Math.min(5000, end - Date.now())));
    const cpu1 = await Promise.all(peers.map((p) => p.cpuMetrics()));
    procCpuPct = cpuPctBetween(proc0, await browserCpu());

    for (const [i, p] of peers.entries()) {
      const pd = ensureDir(join(dir, p.label));
      const crashed = p.page.isClosed();
      const hasQaHook = !crashed && (await p.hasHook());
      const timeline = hasQaHook ? await p.timeline() : [];
      const logs = hasQaHook ? await p.logs() : [];
      cpu[p.label] = cpuPct(cpu0[i] ?? null, cpu1[i] ?? null);
      writeFileSync(join(pd, "logs.json"), JSON.stringify(logs, null, 1));
      writeFileSync(join(pd, "timeline.json"), JSON.stringify(timeline));
      if (p.joinClickedAt !== null) ramps[p.label] = rampFor(timeline, logs, p.joinClickedAt);
      writeFileSync(
        join(pd, "console.txt"),
        [
          ...p.console.map((c) => `${new Date(c.t).toISOString()} ${c.type} ${c.text}`),
          ...p.pageErrors.map((e) => `PAGEERROR ${e}`),
          ...p.failedRequests.map((r) => `REQUESTFAILED ${r}`),
        ].join("\n"),
      );
      if (!crashed) await p.screenshot(join(pd, "screenshot.png"));
      evidence.push({
        label: p.label,
        connectedMs: connected[i] ?? null,
        firstFrameMs: firstFrames[i] ?? null,
        timeline,
        logs,
        pageErrors: p.pageErrors,
        consoleErrors: p.console.filter((c) => c.type === "error").map((c) => c.text),
        crashed,
        hasQaHook,
      });
    }
  } finally {
    for (const t of timers) clearTimeout(t);
    await Promise.all(peers.map((p) => p.close()));
    await shared?.close().catch(() => {});
    if (containers.length) await stopPeerContainers(containers);
  }
  const rampWorst = worstRamp(Object.values(ramps).flat());
  writeFileSync(join(dir, "ramp.json"), JSON.stringify({ worst: rampWorst, peers: ramps }, null, 1));
  log(
    `ramp (worst stream): time-to-target ${rampWorst.time_to_target_s ?? "never"} s, time-to-80%-cap ${rampWorst.time_to_kbps_s ?? "never"} s, overshoot ${rampWorst.overshoot_pct ?? "—"} %; browser CPU ${procCpuPct === null ? "—" : `${Math.round(procCpuPct)} % of one core`}`,
  );

  const workerLog = readFrom(DEV_LOG, devLogOffset);
  writeFileSync(join(dir, "worker.log"), workerLog);
  writeFileSync(
    join(dir, "cpu.json"),
    JSON.stringify(
      {
        unit: "% of one core, renderer main thread (CDP TaskDuration)",
        cpu,
        browser_tree_pct: procCpuPct,
        browser_tree_unit: "% of one core, all local browser processes incl. encoder threads",
      },
      null,
      2,
    ),
  );
  const input: DiagInput = { participants: n, peers: evidence, workerLog, faults, t0 };
  const anomalies: Anomaly[] = findAnomalies(input);
  const meta = {
    started: started.toISOString(),
    finished: new Date().toISOString(),
    url,
    durationS: duration,
    shaping,
    faults,
    cpu,
    browserCpuPct: procCpuPct,
    flags,
    ramp: rampWorst,
    dir,
  };
  writeFileSync(join(dir, "summary.md"), renderDiagSummary(input, anomalies, meta));
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ ...meta, anomalies }, null, 2));
  const hard = anomalies.filter((x) => x.severity === "hard");
  console.log(
    `${hard.length} hard / ${anomalies.length - hard.length} soft anomalies → ${join(dir, "summary.md")}`,
  );
  for (const x of hard.slice(0, 10))
    console.log(`  HARD ${x.rule}${x.peer ? ` ${x.peer}` : ""}: ${x.detail}`);
  return hard.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(2);
  });
