/**
 * Headless Chromium participants for the lab and diag: one browser instance per participant (no shared-process
 * CPU skew), fake or file-fed media, driven through the UI testids and the QA hook (`?qa=1`).
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
  return [...a, ...extra];
}

export class Peer {
  readonly console: ConsoleLine[] = [];
  readonly pageErrors: string[] = [];
  readonly failedRequests: string[] = [];
  joinClickedAt: number | null = null;
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
    const browser = o.wsEndpoint
      ? await chromium.connect(o.wsEndpoint, {
          headers: { "x-playwright-launch-options": JSON.stringify({ args, headless: true }) },
          timeout: 30_000,
        })
      : await chromium.launch({ args, headless: true });
    const context = await browser.newContext({
      permissions: ["camera", "microphone"],
      viewport: { width: 960, height: 600 },
    });
    const page = await context.newPage();
    return new Peer(o.label, o.name, browser, context, page);
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
    await this.page.goto(withQa(`${appUrl}/`));
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
    await this.page.goto(withQa(target));
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
    await this.browser.close().catch(() => {});
  }
}

export function withQa(url: string): string {
  const u = new URL(url);
  u.searchParams.set("qa", "1");
  return u.toString();
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
