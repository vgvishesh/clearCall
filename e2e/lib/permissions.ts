/**
 * Permission-coach helpers: count getUserMedia calls, read the Permissions API, drive the lobby's Get ready step.
 */
import { type BrowserContext, expect, type Page } from "@playwright/test";
import type { Participant } from "./call.ts";
import { qaState, TID, tid, withQa } from "./qa.ts";

declare global {
  interface Window {
    /** Every getUserMedia call's constraints since page load (installed by `countGetUserMedia`). */
    __gumCalls?: MediaStreamConstraints[];
  }
}

/** Records every navigator.mediaDevices.getUserMedia call of every page of this context (re-installed per load). */
export async function countGetUserMedia(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const md = navigator.mediaDevices;
    window.__gumCalls = [];
    if (!md?.getUserMedia) return;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = (c?: MediaStreamConstraints) => {
      window.__gumCalls!.push(JSON.parse(JSON.stringify(c ?? {})) as MediaStreamConstraints);
      return orig(c);
    };
  });
}

/**
 * Make camera/microphone that were never granted read "prompt" in the Permissions API, as in a real browser that hasn't
 * asked yet. Chromium in headless mode (no prompt UI) reports such permissions as "denied", which the app correctly
 * treats as "blocked earlier" (straight to the help steps) — so without this the Get ready step can't be reached in
 * headless E2E. Real grants (`context.grantPermissions`) still read "granted" and fire `change` as usual.
 * Don't use it in tests about a real denial.
 */
export async function emulateUnaskedPermissions(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const proto = PermissionStatus.prototype;
    const real = Object.getOwnPropertyDescriptor(proto, "state")?.get;
    if (!real) return;
    Object.defineProperty(proto, "state", {
      configurable: true,
      get(this: PermissionStatus) {
        const v = real.call(this) as PermissionState;
        return v === "denied" ? "prompt" : v;
      },
    });
  });
}

/** getUserMedia calls (their constraints) on this page since it loaded. */
export const gumCalls = (page: Page): Promise<MediaStreamConstraints[]> =>
  page.evaluate(() => window.__gumCalls ?? []);

/** Permissions API view of camera / microphone ("unsupported" where the browser can't query it). */
export async function permissionStates(page: Page): Promise<{ camera: string; microphone: string }> {
  return page.evaluate(async () => {
    const q = async (name: string) => {
      try {
        return (await navigator.permissions.query({ name: name as PermissionName })).state as string;
      } catch {
        return "unsupported";
      }
    };
    return { camera: await q("camera"), microphone: await q("microphone") };
  });
}

/** Origin of the page's current URL (for `context.grantPermissions`). */
export const originOf = (page: Page): string => new URL(page.url()).origin;

/** The `#secret` part of a call link (without the '#'). */
export const secretOf = (link: string): string => link.slice(link.indexOf("#") + 1);

/** Home → Start a call → lobby; returns the shareable link without joining. */
export async function newLink(p: Participant): Promise<string> {
  await p.page.goto(withQa("/"));
  await p.page.locator(tid(TID.startCall)).click();
  await expect(p.page.locator(tid(TID.lobby))).toBeVisible();
  await expect.poll(async () => (await qaState(p.page)).link, { message: "state().link" }).toBeTruthy();
  return (await qaState(p.page)).link!;
}

/**
 * Opens the link in a context without camera/mic permissions and asserts the Get ready step: prime + "Turn on camera
 * & mic" visible, prepare() finished (phase lobby, link known), mediaRequest "not-asked", no getUserMedia call, no
 * stream. Needs `countGetUserMedia(p.context)` first.
 */
export async function expectGetReady(p: Participant, link: string): Promise<void> {
  const { page } = p;
  await page.goto(withQa(link));
  await expect(page.locator(tid(TID.lobby))).toBeVisible();
  // Precondition: this context really has no grant (else the controller is right to acquire straight away).
  expect((await permissionStates(page)).camera, "precondition: camera not pre-granted").not.toBe("granted");
  await expect(page.locator(tid(TID.permissionPrime))).toBeVisible();
  await expect(page.locator(tid(TID.allowMedia))).toBeVisible();
  await expect
    .poll(async () => {
      const s = await qaState(page);
      return { phase: s.phase, link: !!s.link, req: s.local.mediaRequest };
    })
    .toEqual({ phase: "lobby", link: true, req: "not-asked" });
  expect(await gumCalls(page), "getUserMedia calls before any tap").toEqual([]);
  expect((await qaState(page)).local.stream).toBeNull();
}

/**
 * After a Get-ready action that may or may not join by itself (e.g. "Join with sound only"): wait until the media
 * request settled or the join started, then press Join if still in the lobby; ends on the call screen.
 */
export async function finishJoin(p: Participant): Promise<void> {
  const { page } = p;
  await expect
    .poll(
      async () => {
        const s = await qaState(page);
        return s.phase !== "lobby" || s.local.mediaRequest === "done";
      },
      { message: `${p.name}: media request settled or join started` },
    )
    .toBe(true);
  if ((await qaState(page)).phase === "lobby") {
    await page.locator(tid(TID.nameInput)).fill(p.name);
    await page.locator(tid(TID.joinButton)).click();
  }
  await expect(page.locator(tid(TID.callScreen))).toBeVisible();
}
