/**
 * Headless Chromium participants for the lab and diag: one browser instance per participant (no shared-process
 * CPU skew) or — for large calls (host limit: > ~6 Chromium processes throttles the shared M1) — one shared browser
 * with one context per participant (`LaunchOptions.browser`). Fake or file-fed media, driven through the UI
 * testids and the QA hook (`?qa=1`).
 */
import { type Browser, type BrowserContext, type CDPSession, chromium, type Page } from "@playwright/test";
import { TID } from "../../web/src/core/testids.ts";
import type { CallState, LogEntry, QaHook, QaPeerStats, QaStatsSample } from "../../web/src/core/types.ts";

declare global {
  interface Window {
    __clearcall?: QaHook;
    __labRec?: Record<string, Blob>;
  }
}

export interface PeerMedia {
  /** y4m for --use-file-for-fake-video-capture (path as seen by the browser). */
  video?: string;
  /** wav for --use-file-for-fake-audio-capture. `%noloop` is NOT appended — the clip loops. */
  audio?: string;
}

export interface LaunchOptions {
  label: string;
  name: string;
  media?: PeerMedia;
  /** Remote Playwright server (netem container): ws endpoint. */
  wsEndpoint?: string;
  /** Extra Chromium args (e.g. --unsafely-treat-insecure-origin-as-secure=…). */
  extraArgs?: string[];
  /** App URL flags added to every page load, e.g. "abr=40000&ns=0" (core/deps.ts parses them). */
  flags?: string;
  /** Shared browser (one context per participant). The peer then never closes the browser. */
  browser?: Browser;
  /** Page viewport (default 960×600 @1). Phone-like sizes make tiles tall enough for the tier caps to bind. */
  viewport?: Viewport;
  /** Script run in every page before the app (lab instrumentation, e.g. loss emulation). */
  initScript?: string;
  /** Disable the page CSP (only for lab instrumentation that needs Blob workers). */
  bypassCSP?: boolean;
}

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

/** "390x844@3" → viewport; undefined for empty/invalid input. */
export function parseViewport(spec: string | undefined): Viewport | undefined {
  const m = spec ? /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(spec.trim()) : null;
  if (!m) return undefined;
  return { width: Number(m[1]), height: Number(m[2]), deviceScaleFactor: m[3] ? Number(m[3]) : 1 };
}

/** One headless Chromium for N participant contexts (all share the same fake media files). */
export async function launchSharedBrowser(media?: PeerMedia, extraArgs?: string[]): Promise<Browser> {
  return chromium.launch({ args: chromiumArgs(media, extraArgs), headless: true });
}

export interface ConsoleLine {
  t: number;
  type: string;
  text: string;
}

export function chromiumArgs(media?: PeerMedia, extra: string[] = []): string[] {
  const a = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    // Keep timers/rAF running in headless background pages so encoders aren't throttled.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ];
  if (media?.video) a.push(`--use-file-for-fake-video-capture=${media.video}`);
  if (media?.audio) a.push(`--use-file-for-fake-audio-capture=${media.audio}`);
  return [...a, LAB_MARKER, ...extra];
}

export class Peer {
  readonly console: ConsoleLine[] = [];
  readonly pageErrors: string[] = [];
  readonly failedRequests: string[] = [];
  joinClickedAt: number | null = null;
  /** Epoch ms at which every remote had decoded a frame (see watchFirstFrames); null = not yet / timed out. */
  private firstFramesWatch: Promise<number | null> | null = null;
  /** App URL flags for every navigation (see LaunchOptions.flags). */
  flags = "";
  /** false = shared browser (LaunchOptions.browser): close() only closes this peer's context. */
  ownsBrowser = true;
  private cdp: CDPSession | null = null;

  constructor(
    readonly label: string,
    readonly name: string,
    readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
  ) {
    page.on("console", (m) => this.console.push({ t: Date.now(), type: m.type(), text: m.text() }));
    page.on("pageerror", (e) => this.pageErrors.push(`${e.name}: ${e.message}`));
    page.on("requestfailed", (r) =>
      this.failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText ?? ""}`),
    );
  }

  static async launch(o: LaunchOptions): Promise<Peer> {
    const args = chromiumArgs(o.media, o.extraArgs);
    const browser = o.browser
      ? o.browser
      : o.wsEndpoint
        ? await chromium.connect(o.wsEndpoint, {
            headers: { "x-playwright-launch-options": JSON.stringify({ args, headless: true }) },
            timeout: 30_000,
          })
        : await chromium.launch({ args, headless: true });
    const context = await browser.newContext({
      permissions: ["camera", "microphone"],
      viewport: { width: o.viewport?.width ?? 960, height: o.viewport?.height ?? 600 },
      deviceScaleFactor: o.viewport?.deviceScaleFactor ?? 1,
      ...(o.bypassCSP ? { bypassCSP: true } : {}),
    });
    if (o.initScript) await context.addInitScript(o.initScript);
    const page = await context.newPage();
    const peer = new Peer(o.label, o.name, browser, context, page);
    peer.flags = o.flags ?? "";
    peer.ownsBrowser = !o.browser;
    return peer;
  }

  // ── UI flow ──
  private tid(id: string) {
    return this.page.locator(`[data-testid="${id}"]`);
  }

  async joinFromLobby(timeout = 20_000): Promise<void> {
    await this.tid(TID.lobby).waitFor({ timeout });
    await this.tid(TID.nameInput).fill(this.name);
    this.joinClickedAt = Date.now();
    await this.tid(TID.joinButton).click();
    await this.tid(TID.callScreen).waitFor({ timeout });
  }

  /** Home → Start a call → Lobby → Join; returns the link. */
  async startCall(appUrl: string): Promise<string> {
    await this.page.goto(withQa(`${appUrl}/`, this.flags));
    await this.tid(TID.startCall).click();
    await this.joinFromLobby();
    const link = (await this.state()).link;
    if (!link) throw new Error(`${this.label}: no link after starting the call`);
    return link;
  }

  async joinCall(link: string, appUrl?: string): Promise<void> {
    // Containers reach the app under a different host than the host machine; keep path + fragment.
    const u = new URL(link);
    const target = appUrl ? new URL(`${u.pathname}${u.search}${u.hash}`, appUrl).toString() : link;
    await this.page.goto(withQa(target, this.flags));
    await this.joinFromLobby();
  }

  async setMusicMode(): Promise<void> {
    await this.tid(TID.moreMenu).click();
    await this.tid(TID.musicModeToggle).click();
  }

  // ── QA hook ──
  async hasHook(): Promise<boolean> {
    return this.page.evaluate(() => typeof window.__clearcall === "object").catch(() => false);
  }
  async state(): Promise<CallState> {
    return this.page.evaluate(
      () =>
        JSON.parse(
          JSON.stringify(window.__clearcall!.state(), (k, v) =>
            k === "stream" ? (v ? { id: v.id } : null) : v,
          ),
        ) as CallState,
    );
  }
  async stats(): Promise<QaPeerStats[]> {
    return this.page.evaluate(() => window.__clearcall!.stats());
  }
  async timeline(): Promise<QaStatsSample[]> {
    return this.page.evaluate(() => window.__clearcall?.statsTimeline() ?? []).catch(() => []);
  }
  async logs(): Promise<LogEntry[]> {
    return this.page.evaluate(() => window.__clearcall?.logs() ?? []).catch(() => []);
  }
  async inject(fault: "drop-signaling" | "restart-ice" | "kill-peer", participantId?: string): Promise<void> {
    await this.page.evaluate(
      ([f, id]) => window.__clearcall!.inject(f as "drop-signaling", id ?? undefined),
      [fault, participantId ?? null] as const,
    );
  }

  /** Polls until `n - 1` remotes are connected; returns ms since the Join click. */
  async waitConnected(n: number, timeout = 30_000): Promise<number> {
    await poll(
      async () => {
        const s = await this.stats();
        return s.length === n - 1 && s.every((p) => p.connectionState === "connected");
      },
      timeout,
      `${this.label}: ${n - 1} connected remotes`,
    );
    return Date.now() - (this.joinClickedAt ?? Date.now());
  }

  /** Polls until every remote has decoded a video frame; returns ms since the Join click. */
  async waitFirstFrames(timeout = 30_000): Promise<number> {
    await poll(
      async () => {
        const s = await this.stats();
        return s.length > 0 && s.every((p) => (p.video.framesDecoded ?? 0) > 0);
      },
      timeout,
      `${this.label}: first remote frames`,
    );
    return Date.now() - (this.joinClickedAt ?? Date.now());
  }

  /**
   * Start polling (100 ms) right now — call it right after the Join click — for the moment every one of `n - 1`
   * remotes has decoded a frame. Resolves with that epoch ms, or null after `timeout`. Unlike waitFirstFrames it
   * does not wait for the lab's serial joins, so it timestamps the first frame within ~100 ms.
   */
  watchFirstFrames(n: number, timeout = 60_000): void {
    this.firstFramesWatch = (async () => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const ok = await this.stats()
          .then((s) => s.length === n - 1 && s.every((p) => (p.video.framesDecoded ?? 0) > 0))
          .catch(() => false);
        if (ok) return Date.now();
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    })();
  }

  firstFramesAt(): Promise<number | null> {
    return this.firstFramesWatch ?? Promise.resolve(null);
  }

  // ── recording ──
  async startRecording(remoteId: string): Promise<void> {
    await this.page.evaluate((id) => window.__clearcall!.startRecording(id), remoteId);
  }

  /** Stops the recording and transfers the Blob out of the page in 4 MB base64 chunks. */
  async stopRecording(remoteId: string): Promise<Buffer | null> {
    const size = await this.page.evaluate(async (id) => {
      const b = await window.__clearcall!.stopRecording(id);
      if (!b) return 0;
      window.__labRec = { ...(window.__labRec ?? {}), [id]: b };
      return b.size;
    }, remoteId);
    if (!size) return null;
    const parts: Buffer[] = [];
    const CHUNK = 4 * 1024 * 1024;
    for (let off = 0; off < size; off += CHUNK) {
      const b64 = await this.page.evaluate(
        async ([id, start, end]) => {
          const blob = window.__labRec![id as string]!.slice(start as number, end as number);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let s = "";
          for (let i = 0; i < bytes.length; i += 0x8000)
            s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(s);
        },
        [remoteId, off, Math.min(size, off + CHUNK)] as const,
      );
      parts.push(Buffer.from(b64, "base64"));
    }
    return Buffer.concat(parts);
  }

  // ── CPU (CDP) ──
  /** Main-thread task time (s) and timestamp (s) from Performance.getMetrics. */
  async cpuMetrics(): Promise<{ taskS: number; ts: number } | null> {
    try {
      if (!this.cdp) {
        this.cdp = await this.context.newCDPSession(this.page);
        await this.cdp.send("Performance.enable");
      }
      const { metrics } = await this.cdp.send("Performance.getMetrics");
      const get = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0;
      return { taskS: get("TaskDuration"), ts: get("Timestamp") };
    } catch {
      return null;
    }
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path }).catch(() => {});
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    if (this.ownsBrowser) await this.browser.close().catch(() => {});
  }
}

export function withQa(url: string, flags = ""): string {
  const u = new URL(url);
  for (const [k, v] of new URLSearchParams(flags)) u.searchParams.set(k, v);
  u.searchParams.set("qa", "1");
  return u.toString();
}

/** Parse `ps -o time=` ("[[D-]HH:]MM:SS.ss", macOS minutes may exceed 59) to seconds. */
export function parsePsTime(t: string): number {
  const [days, rest] = t.includes("-") ? t.split("-", 2) : ["0", t];
  return Number(days) * 86400 + rest!.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** Cumulative CPU seconds of the given processes and all their descendants (whole-browser CPU incl. encoders). */
export function treeCpuSeconds(psOutput: string, roots: readonly number[]): number {
  const rows = psOutput
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((r) => r.length >= 3)
    .map(([pid, ppid, time]) => ({ pid: Number(pid), ppid: Number(ppid), cpu: parsePsTime(time!) }));
  const children = new Map<number, number[]>();
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r.pid]);
  const want = new Set<number>();
  const stack = [...roots];
  while (stack.length) {
    const p = stack.pop()!;
    if (want.has(p)) continue;
    want.add(p);
    stack.push(...(children.get(p) ?? []));
  }
  return rows.filter((r) => want.has(r.pid)).reduce((a, r) => a + r.cpu, 0);
}

/**
 * Marker switch on every local Chromium this process launches (Chromium ignores unknown switches), so the lab can
 * find its own browser processes without touching the owner's or another worktree's browsers.
 */
export const LAB_MARKER = `--clearcall-lab-run=${process.pid}`;

/** Cumulative whole-tree CPU seconds of this process's local browsers (null when none, e.g. netem containers). */
export async function browserCpu(): Promise<{ cpuS: number; t: number } | null> {
  const { execFile } = await import("node:child_process");
  const out = await new Promise<string>((res) =>
    execFile("ps", ["-A", "-ww", "-o", "pid=,ppid=,time=,command="], { maxBuffer: 64 << 20 }, (err, stdout) =>
      res(err ? "" : stdout),
    ),
  );
  const roots = out
    .split("\n")
    .filter((l) => l.includes(LAB_MARKER))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
  if (!roots.length) return null;
  return { cpuS: treeCpuSeconds(out, roots), t: Date.now() };
}

/** Mean CPU between two snapshots, % of one core (800 = all 8 cores of the host). */
export function cpuPctBetween(
  a: { cpuS: number; t: number } | null,
  b: { cpuS: number; t: number } | null,
): number | null {
  if (!a || !b || b.t <= a.t) return null;
  return (100 * (b.cpuS - a.cpuS)) / ((b.t - a.t) / 1000);
}
/** Poll `fn` every `intervalMs` until truthy or timeout (throws with `what`). */
export async function poll(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
  intervalMs = 250,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `timeout after ${timeoutMs} ms waiting for ${what}${lastErr ? ` (last error: ${String(lastErr)})` : ""}`,
  );
}

/** CPU % of one core used by the page's main thread between two CDP samples. */
export function cpuPct(
  a: { taskS: number; ts: number } | null,
  b: { taskS: number; ts: number } | null,
): number | null {
  if (!a || !b || b.ts <= a.ts) return null;
  return (100 * (b.taskS - a.taskS)) / (b.ts - a.ts);
}
