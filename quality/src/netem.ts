/**
 * Network shaping with Docker + `tc netem` (macOS can't shape browser UDP). Each participant's Chromium runs in a
 * container (Playwright run-server) whose eth0 egress carries delay/jitter/loss/uplink rate and whose ingress is
 * redirected to ifb0 for the downlink rate. The lab connects with `chromium.connect()`.
 *
 * Model: a packet A→B crosses A's egress (delay, jitter, loss, up rate) and B's ingress (down rate), so the
 * one-way delay is `delay_ms` and RTT ≈ 2 × delay_ms, as the profiles assume ("150 ms ≈ 300 ms RTT").
 */
import { join } from "node:path";
import type { LinkState } from "./profiles.ts";
import { log, MEDIA_DIR, QUALITY_DIR, run } from "./util.ts";

export const IMAGE = "clearcall-lab-peer:1.64.0";
export const NETWORK = "clearcall-lab";
const PW_PORT = 3000;

/** Gilbert-Elliott parameters for a mean loss (%) with mean burst length `burst` packets: p = L·r/(1−L), r = 1/burst. */
export function gilbertParams(lossPct: number, burst = 2): { p: number; r: number } {
  const L = Math.min(Math.max(lossPct / 100, 0), 0.99);
  const r = 1 / burst;
  return { p: (L * r) / (1 - L), r };
}

const pct = (x: number) => `${Number((x * 100).toFixed(4))}%`;

/**
 * Egress root that keeps lab control traffic out of the shaped path: a prio qdisc whose default band (1:3) carries
 * the netem qdisc, plus a u32 filter sending TCP source port `bypassPort` (the Playwright run-server's replies:
 * CDP, stats polls, multi-MB recording transfers) to the unshaped band 1:1. Everything else (WebRTC media,
 * signaling via the forwarder) is shaped. Without it a 36 MB recording transfer over a 3 Mbit/s, 1 %-loss,
 * jittered (reordering) link stalls the lab for >10 min.
 */
export function egressBypassSetup(bypassPort: number, dev = "eth0"): string[][] {
  return [
    [
      "tc",
      "qdisc",
      "add",
      "dev",
      dev,
      "root",
      "handle",
      "1:",
      "prio",
      "bands",
      "3",
      "priomap",
      ...Array(16).fill("2"),
    ],
    [
      "tc",
      "filter",
      "add",
      "dev",
      dev,
      "parent",
      "1:",
      "protocol",
      "ip",
      "prio",
      "1",
      "u32",
      "match",
      "ip",
      "sport",
      String(bypassPort),
      "0xffff",
      "flowid",
      "1:1",
    ],
  ];
}

/**
 * `tc qdisc <op> dev <dev> root netem …` for the egress side, or under the shaped band of `egressBypassSetup`
 * (`parent 1:3 handle 30:`) when `underBypass`.
 */
export function egressNetem(
  link: LinkState,
  op: "add" | "change",
  dev = "eth0",
  underBypass = false,
): string[] {
  const where = underBypass ? ["parent", "1:3", "handle", "30:"] : ["root"];
  const a = ["tc", "qdisc", op, "dev", dev, ...where, "netem"];
  if (link.delay_ms > 0 || link.jitter_ms > 0) {
    a.push("delay", `${link.delay_ms}ms`);
    if (link.jitter_ms > 0) a.push(`${link.jitter_ms}ms`, "distribution", "normal");
  }
  if (link.loss_pct > 0) {
    if (link.loss_model === "gilbert") {
      const { p, r } = gilbertParams(link.loss_pct);
      a.push("loss", "gemodel", pct(p), pct(r));
    } else a.push("loss", "random", `${link.loss_pct}%`);
  }
  a.push("rate", `${link.up_kbps}kbit`);
  // Queue sized for ~200 ms at the shaped rate (min 50 pkts) — bufferbloat-ish but bounded, like a phone uplink.
  a.push("limit", String(queueLimit(link.up_kbps)));
  return a;
}

export function queueLimit(kbps: number, ms = 200, mtu = 1200): number {
  return Math.max(50, Math.ceil((kbps * 1000 * (ms / 1000)) / 8 / mtu));
}

/** Commands to shape the downlink via ifb0 (rate only — delay/loss are on the sender's egress). */
export function ingressSetup(link: LinkState, dev = "eth0"): string[][] {
  return [
    ["ip", "link", "add", "ifb0", "type", "ifb"],
    ["ip", "link", "set", "ifb0", "up"],
    ["tc", "qdisc", "add", "dev", dev, "handle", "ffff:", "ingress"],
    [
      "tc",
      "filter",
      "add",
      "dev",
      dev,
      "parent",
      "ffff:",
      "protocol",
      "all",
      "u32",
      "match",
      "u32",
      "0",
      "0",
      "action",
      "mirred",
      "egress",
      "redirect",
      "dev",
      "ifb0",
    ],
    ingressNetem(link, "add"),
  ];
}

export function ingressNetem(link: LinkState, op: "add" | "change"): string[] {
  return [
    "tc",
    "qdisc",
    op,
    "dev",
    "ifb0",
    "root",
    "netem",
    "rate",
    `${link.down_kbps}kbit`,
    "limit",
    String(queueLimit(link.down_kbps)),
  ];
}

export async function dockerAvailable(): Promise<{ ok: boolean; why?: string }> {
  const r = await run("docker", ["info", "--format", "{{.ServerVersion}}"], { allowFail: true }).catch(
    () => null,
  );
  if (!r) return { ok: false, why: "docker CLI not found" };
  if (r.code !== 0)
    return {
      ok: false,
      why: "Docker daemon not running — start it with `open -a Docker`, wait ~30 s, retry",
    };
  return { ok: true };
}

export async function ensureImage(): Promise<void> {
  const has = await run("docker", ["image", "inspect", IMAGE], { allowFail: true });
  if (has.code === 0) return;
  log(`building ${IMAGE} (first run pulls the Playwright image, several minutes)`);
  await run("docker", ["build", "-t", IMAGE, join(QUALITY_DIR, "netem")]);
}

export async function ensureNetwork(): Promise<void> {
  const r = await run("docker", ["network", "inspect", NETWORK], { allowFail: true });
  if (r.code !== 0) await run("docker", ["network", "create", NETWORK]);
}

export interface PeerContainer {
  name: string;
  wsEndpoint: string;
  /** Downlink shaping could not be set up (no ifb in the Docker VM kernel). */
  ingressShaped: boolean;
}

async function exec(name: string, cmd: string[], allowFail = false) {
  return run("docker", ["exec", name, ...cmd], { allowFail });
}

/**
 * Run-server command. `--unsafe` is required in Playwright 1.64: without it the server silently drops the
 * client's launch `args` (fake media files, autoplay, …). The port is published on 127.0.0.1 only.
 */
export const RUN_SERVER_CMD = [
  "playwright",
  "run-server",
  "--port",
  String(PW_PORT),
  "--host",
  "0.0.0.0",
  "--unsafe",
];

/**
 * In-container TCP forwarder 127.0.0.1:<port> → host.docker.internal:<port>, so the page loads from
 * `http://localhost:<port>` — a secure context (getUserMedia) without `--unsafely-treat-insecure-origin-as-secure`,
 * which chrome-headless-shell ignores.
 */
export function forwarderCmd(port: number, target = "host.docker.internal"): string[] {
  const js =
    `const n=require("net");n.createServer(c=>{const u=n.connect(${port},${JSON.stringify(target)});` +
    `c.pipe(u).pipe(c);const k=()=>{c.destroy();u.destroy()};c.on("error",k);u.on("error",k)})` +
    `.listen(${port},"127.0.0.1")`;
  return ["node", "-e", js];
}

/** Host port to forward when the app runs on the host's loopback, else null. */
export function hostLoopbackPort(hostUrl: string): number | null {
  const u = new URL(hostUrl);
  if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return null;
  return Number(u.port || (u.protocol === "https:" ? 443 : 80));
}

export async function startPeerContainer(
  index: number,
  link: LinkState,
  hostAppUrl?: string,
): Promise<PeerContainer> {
  const name = `clearcall-lab-p${index}`;
  await run("docker", ["rm", "-f", name], { allowFail: true });
  await run("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--network",
    NETWORK,
    "--cap-add",
    "NET_ADMIN",
    "--shm-size",
    "1g",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-v",
    `${MEDIA_DIR}:/media:ro`,
    "-p",
    `127.0.0.1::${PW_PORT}`,
    IMAGE,
    ...RUN_SERVER_CMD,
  ]);
  const fwd = hostAppUrl ? hostLoopbackPort(hostAppUrl) : null;
  if (fwd !== null) {
    await run("docker", ["exec", "-d", name, ...forwarderCmd(fwd)]);
    // Poll until the forwarder reaches the app end to end (bounded), so the first page.goto can't race it.
    const probe = `fetch("http://127.0.0.1:${fwd}/").then(()=>process.exit(0),()=>process.exit(1))`;
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      ok = (await exec(name, ["node", "-e", probe], true)).code === 0;
      if (!ok) await new Promise((r) => setTimeout(r, 250));
    }
    if (!ok) throw new Error(`${name}: app not reachable through the in-container forwarder on :${fwd}`);
  }
  const port = (await run("docker", ["port", name, String(PW_PORT)])).stdout
    .trim()
    .split("\n")[0]
    ?.split(":")
    .at(-1);
  if (!port) throw new Error(`${name}: no published port`);
  for (const c of egressBypassSetup(PW_PORT)) await run("docker", ["exec", name, ...c]);
  await run("docker", ["exec", name, ...egressNetem(link, "add", "eth0", true)]);
  let ingressShaped = true;
  for (const c of ingressSetup(link)) {
    if ((await exec(name, c, true)).code !== 0) {
      ingressShaped = false;
      break;
    }
  }
  return { name, wsEndpoint: `ws://127.0.0.1:${port}/`, ingressShaped };
}

export async function updateLink(c: PeerContainer, link: LinkState): Promise<void> {
  await exec(c.name, egressNetem(link, "change", "eth0", true));
  if (c.ingressShaped) await exec(c.name, ingressNetem(link, "change"), true);
}

export async function stopPeerContainers(cs: PeerContainer[]): Promise<void> {
  await Promise.all(cs.map((c) => run("docker", ["rm", "-f", c.name], { allowFail: true })));
}

/**
 * App URL as seen from inside a container. A host-loopback app is reached through the in-container forwarder
 * (`startPeerContainer(…, hostAppUrl)`) at `localhost`, which keeps it a secure context; no extra flags needed.
 */
export function containerAppUrl(hostUrl: string): { url: string; args: string[] } {
  const u = new URL(hostUrl);
  if (u.hostname === "127.0.0.1") u.hostname = "localhost";
  return { url: u.origin, args: [] };
}

/** Host media path → container path (MEDIA_DIR is mounted at /media). */
export function containerMediaPath(hostPath: string): string {
  if (!hostPath.startsWith(MEDIA_DIR))
    throw new Error(`${hostPath} is not under ${MEDIA_DIR} (only cache media is mounted)`);
  return `/media${hostPath.slice(MEDIA_DIR.length)}`;
}
