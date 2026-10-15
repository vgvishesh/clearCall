/**
 * Multi-participant call helpers. Each participant = its own BrowserContext (separate storage),
 * optionally its own Browser instance (rarely needed: one Chromium with 10 contexts handles a 10-party mesh).
 * All waits are polls with timeouts — never fixed sleeps.
 */
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  expect,
  type Page,
} from "@playwright/test";
import { Diagnostics } from "./diagnostics.ts";
import { type QaPeerStats, qaState, qaStats, TID, tid, withQa } from "./qa.ts";

export interface Participant {
  name: string;
  context: BrowserContext;
  page: Page;
  diag: Diagnostics;
  /** Set when this participant owns a dedicated browser instance (closed with it). */
  ownBrowser?: Browser;
}

export interface NewParticipantOptions {
  /** Close this browser together with the participant (use for dedicated instances). */
  ownBrowser?: boolean;
  contextOptions?: BrowserContextOptions;
}

export async function newParticipant(
  browser: Browser,
  name: string,
  opts: NewParticipantOptions = {},
): Promise<Participant> {
  const context = await browser.newContext(opts.contextOptions);
  const page = await context.newPage();
  const diag = new Diagnostics(name);
  diag.watch(page);
  return { name, context, page, diag, ...(opts.ownBrowser ? { ownBrowser: browser } : {}) };
}

export async function closeParticipant(p: Participant): Promise<void> {
  await p.context.close().catch(() => {});
  if (p.ownBrowser) await p.ownBrowser.close().catch(() => {});
}

/**
 * Permission coach: when the lobby shows the "Get ready" step (`local.mediaRequest === "not-asked"`: Firefox/WebKit
 * contexts without pre-granted permissions, or any browser whose Permissions API doesn't report "granted"), tap
 * "Turn on camera & mic" once, from a real click. When permissions are pre-granted (Chromium projects) the controller
 * acquires on its own and nothing is tapped. Resolves once the request has started ("asking") or finished ("done").
 * Polls the QA state — no fixed waits; a controller without `mediaRequest` (pre-coach build) counts as "done".
 */
export async function allowMediaIfAsked(page: Page, timeout = 15_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const req = (await qaState(page)).local.mediaRequest ?? "done";
        if (req !== "not-asked") return req;
        const allow = page.locator(tid(TID.allowMedia));
        // The prime can vanish between isVisible and click (prepare() finishing its permission query) — retry.
        if (await allow.isVisible()) await allow.click({ timeout: 1_000 }).catch(() => {});
        return req;
      },
      { timeout, intervals: [100, 250, 500], message: "camera/mic request never started (Get ready step)" },
    )
    .not.toBe("not-asked");
}

/** Lobby → (tap "Turn on camera & mic" if asked) → fill name → Join → call screen. */
export async function joinFromLobby(p: Participant): Promise<void> {
  const { page } = p;
  await expect(page.locator(tid(TID.lobby))).toBeVisible();
  await allowMediaIfAsked(page);
  await page.locator(tid(TID.nameInput)).fill(p.name);
  await page.locator(tid(TID.joinButton)).click();
  await expect(page.locator(tid(TID.callScreen))).toBeVisible();
}

/** Home → Start a call → Lobby → Join. Returns the shareable link (`https://host/c#secret`). */
export async function startCall(p: Participant): Promise<string> {
  await p.page.goto(withQa("/"));
  await p.page.locator(tid(TID.startCall)).click();
  await joinFromLobby(p);
  const link = (await qaState(p.page)).link;
  expect(link, "state().link after starting a call").toBeTruthy();
  return link!;
}

/** Open the link (with ?qa=1) → Lobby → Join. */
export async function joinCall(p: Participant, link: string): Promise<void> {
  await p.page.goto(withQa(link));
  await joinFromLobby(p);
}

/** Every one of `n - 1` remote peers reports connectionState "connected" (QA stats) and is listed in state. */
export async function waitConnected(page: Page, n: number, timeout = 15_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const [state, stats] = await Promise.all([qaState(page), qaStats(page)]);
        const connected = stats.filter((s) => s.connectionState === "connected").length;
        return { participants: state.participants.length, connected, phase: state.phase };
      },
      { timeout, message: `waiting for ${n - 1} connected remote peers` },
    )
    .toEqual({ participants: n - 1, connected: n - 1, phase: "in-call" });
}

/** Waits for a full mesh: every participant sees all others connected. */
export async function waitAllConnected(ps: Participant[], timeout = 15_000): Promise<void> {
  await Promise.all(ps.map((p) => waitConnected(p.page, ps.length, timeout)));
}

function counters(s: QaPeerStats, video: boolean) {
  return {
    frames: video ? (s.video.framesDecoded ?? 0) : 0,
    bytes: (s.audio.bytesReceived ?? 0) + (video ? (s.video.bytesReceived ?? 0) : 0),
  };
}

/**
 * Media flows from every remote peer: framesDecoded (unless `video: false`) and bytesReceived strictly increase
 * over a ≥ 2 s window. Optional `from` restricts to remote participant ids.
 */
export async function expectMediaFlowing(
  page: Page,
  opts: { video?: boolean; windowMs?: number; timeout?: number; from?: string[]; label?: string } = {},
): Promise<void> {
  const video = opts.video ?? true;
  const who = opts.label ? ` at ${opts.label}` : "";
  const windowMs = opts.windowMs ?? 2000;
  const pick = (all: QaPeerStats[]) => (opts.from ? all.filter((s) => opts.from!.includes(s.id)) : all);
  const t0 = Date.now();
  const base = new Map(pick(await qaStats(page)).map((s) => [s.id, counters(s, video)]));
  expect(base.size, "remote peers in stats()").toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const now = pick(await qaStats(page));
        // Each stalled peer is reported with what stalled (audio+video bytes and/or decoded frames) so the failure
        // message alone tells the direction and the kind.
        const stalled: string[] = [];
        for (const s of now) {
          const b = base.get(s.id);
          const c = counters(s, video);
          const what = !b
            ? ["new"]
            : [
                ...(c.bytes <= b.bytes ? [`bytes ${b.bytes}→${c.bytes}`] : []),
                ...(video && c.frames <= b.frames ? [`frames ${b.frames}→${c.frames}`] : []),
              ];
          if (what.length) stalled.push(`${s.name || s.id} (${what.join(", ")})`);
        }
        if (Date.now() - t0 < windowMs) return ["(window not elapsed)"];
        return stalled;
      },
      {
        timeout: opts.timeout ?? 10_000,
        intervals: [250, 500],
        message: `remote peers with stalled media${who}`,
      },
    )
    .toEqual([]);
}

/** Remote audio is audible: every remote peer reports audioLevel > 0 at some sample (fake device beeps). */
export async function expectAudio(
  page: Page,
  opts: { timeout?: number; from?: string[] } = {},
): Promise<void> {
  const heard = new Set<string>();
  await expect
    .poll(
      async () => {
        const stats = await qaStats(page);
        const remotes = opts.from ? stats.filter((s) => opts.from!.includes(s.id)) : stats;
        for (const s of remotes) if ((s.audio.audioLevel ?? 0) > 0) heard.add(s.id);
        return remotes.filter((s) => !heard.has(s.id)).map((s) => s.name || s.id);
      },
      { timeout: opts.timeout ?? 10_000, intervals: [100, 200], message: "remote peers never heard" },
    )
    .toEqual([]);
}

/** Remote participant record (from QA state) by display name. */
export async function remoteByName(page: Page, name: string) {
  return (await qaState(page)).participants.find((r) => r.name === name);
}

/** Tile locator of a remote participant by display name. */
export function remoteTile(page: Page, name: string) {
  return page.locator(`${tid(TID.participantTile)}[data-name="${name}"]`);
}

/** Starts a call with `ps[0]` and joins the rest (sequentially — join order matters for FLOWS §1). */
export async function setupCall(ps: Participant[], timeout = 15_000): Promise<string> {
  const [host, ...guests] = ps;
  if (!host) throw new Error("setupCall: no participants");
  const link = await startCall(host);
  for (const g of guests) await joinCall(g, link);
  await waitAllConnected(ps, timeout);
  return link;
}

/**
 * Reveals the call controls dock. In a 2-party video call the UI hides the header/footer after 4 s without input
 * (`.is-chrome-hidden`: opacity 0, pointer-events none); a mouse move over the call screen reveals them and restarts
 * the timer. Polls — moving the mouse between two points so every attempt is a real move — until the dock is shown.
 */
export async function showControls(page: Page, timeout = 5_000): Promise<void> {
  const screen = page.locator(tid(TID.callScreen));
  let flip = false;
  await expect
    .poll(
      async () => {
        const hidden = await screen.evaluate((el) => el.classList.contains("is-chrome-hidden"));
        if (!hidden) return false;
        const box = await screen.boundingBox();
        if (box) {
          flip = !flip;
          await page.mouse.move(box.x + box.width / 2 + (flip ? 10 : -10), box.y + box.height / 2);
        }
        return true;
      },
      { timeout, intervals: [50, 100, 250], message: "call controls still hidden after mouse moves" },
    )
    .toBe(false);
}

/** Clicks a call-dock control (mic, camera, leave, more…), revealing the auto-hidden dock first. */
export async function clickControl(page: Page, testId: string): Promise<void> {
  await showControls(page);
  await page.locator(tid(testId)).click();
}
