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

/** `tc qdisc <op> dev <dev> root netem …` for the egress side. */
export function egressNetem(link: LinkState, op: "add" | "change", dev = "eth0"): string[] {
  const a = ["tc", "qdisc", op, "dev", dev, "root", "netem"];
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

export async function startPeerContainer(index: number, link: LinkState): Promise<PeerContainer> {
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
  ]);
  const port = (await run("docker", ["port", name, String(PW_PORT)])).stdout
    .trim()
    .split("\n")[0]
    ?.split(":")
    .at(-1);
  if (!port) throw new Error(`${name}: no published port`);
  await run("docker", ["exec", name, ...egressNetem(link, "add")]);
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
  await exec(c.name, egressNetem(link, "change"));
  if (c.ingressShaped) await exec(c.name, ingressNetem(link, "change"), true);
}

export async function stopPeerContainers(cs: PeerContainer[]): Promise<void> {
  await Promise.all(cs.map((c) => run("docker", ["rm", "-f", c.name], { allowFail: true })));
}

/** App URL as seen from inside a container, plus the flag that makes it a secure context for getUserMedia. */
export function containerAppUrl(hostUrl: string): { url: string; args: string[] } {
  const u = new URL(hostUrl);
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") u.hostname = "host.docker.internal";
  const url = u.origin;
  return { url, args: u.protocol === "http:" ? [`--unsafely-treat-insecure-origin-as-secure=${url}`] : [] };
}

/** Host media path → container path (MEDIA_DIR is mounted at /media). */
export function containerMediaPath(hostPath: string): string {
  if (!hostPath.startsWith(MEDIA_DIR))
    throw new Error(`${hostPath} is not under ${MEDIA_DIR} (only cache media is mounted)`);
  return `/media${hostPath.slice(MEDIA_DIR.length)}`;
}
