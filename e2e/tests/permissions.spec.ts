/**
 * Permission coach (docs/plans/permission-coach.md): the camera/mic prompt only ever follows a tap, a blocked prompt
 * gets browser-specific help and recovers, nobody is stuck (sound only / just listen), and in-app browsers are sent to
 * a real browser with the #secret intact.
 *
 * Cases 1–4 grant/deny camera+mic through Chromium's permission overrides (`context.grantPermissions`) and so run on
 * the chromium project only; the in-app browser cases (5) depend on the user agent only and run on every engine.
 * The denied case needs the full Chromium (`channel: "chromium"`, see e2e/CLAUDE.md) — one extra process, at most.
 */
import type { Page } from "@playwright/test";
import { expectAudio, expectMediaFlowing, joinFromLobby, startCall, waitAllConnected } from "../lib/call.ts";
import { expect, test } from "../lib/fixtures.ts";
import {
  countGetUserMedia,
  emulateUnaskedPermissions,
  expectGetReady,
  finishJoin,
  gumCalls,
  newLink,
  originOf as origin,
  secretOf,
} from "../lib/permissions.ts";
import { qaState, qaStats, TID, tid, withQa } from "../lib/qa.ts";

/** The host's stats for its only remote peer. */
async function onlyRemote(page: Page) {
  const stats = await qaStats(page);
  expect(stats).toHaveLength(1);
  return stats[0]!;
}

test.describe("permission coach — prompt only after a tap", () => {
  test.beforeEach(({ browserName }) => {
    test.skip(
      browserName !== "chromium",
      "grants/denies camera+mic through Chromium permission overrides (Firefox has no camera permission override)",
    );
  });

  test("not asked yet: Get ready, no getUserMedia before the tap; tap → preview → 2-peer call", async ({
    call,
  }) => {
    test.setTimeout(90_000);
    const host = await call.participant("Hana");
    const guest = await call.participant("Gil", { contextOptions: { permissions: [] } });
    await countGetUserMedia(guest.context);
    await emulateUnaskedPermissions(guest.context);
    const link = await startCall(host);

    await expectGetReady(guest, link);
    // The user taps "Turn on camera & mic" and then Allow on the browser prompt (= the grant).
    await guest.context.grantPermissions(["camera", "microphone"], { origin: origin(guest.page) });
    await guest.page.locator(tid(TID.allowMedia)).click();
    await expect(guest.page.locator(tid(TID.lobbyPreview))).toBeVisible();
    await expect(guest.page.locator(tid(TID.permissionPrime))).not.toBeVisible();
    await expect
      .poll(async () => {
        const s = await qaState(guest.page);
        return {
          req: s.local.mediaRequest,
          stream: !!s.local.stream,
          cam: s.local.camAvailable,
          mic: s.local.micAvailable,
          error: s.error,
        };
      })
      .toEqual({ req: "done", stream: true, cam: true, mic: true, error: null });
    expect((await gumCalls(guest.page)).length, "getUserMedia after the tap").toBeGreaterThanOrEqual(1);

    await joinFromLobby(guest);
    await waitAllConnected([host, guest]);
    // Bytes (audio+video) and decoded frames increase both ways.
    await expectMediaFlowing(host.page, { label: host.name });
    await expectMediaFlowing(guest.page, { label: guest.name });
    await expectAudio(host.page);
    await expectAudio(guest.page);
    for (const p of call.all) expect(p.diag.pageErrors, `${p.name} page errors`).toEqual([]);
  });

  test("already granted: no Get ready step, straight to the preview", async ({ call }) => {
    const host = await call.participant("Hana");
    const guest = await call.participant("Gil"); // project default: camera + microphone granted
    await countGetUserMedia(guest.context);
    await emulateUnaskedPermissions(guest.context);
    const link = await newLink(host);

    await guest.page.goto(withQa(link));
    await expect(guest.page.locator(tid(TID.lobby))).toBeVisible();
    await expect(guest.page.locator(tid(TID.lobbyPreview))).toBeVisible();
    await expect
      .poll(async () => {
        const s = await qaState(guest.page);
        return { req: s.local.mediaRequest, stream: !!s.local.stream };
      })
      .toEqual({ req: "done", stream: true });
    // Acquired without any tap, and the Get ready step never had a reason to show.
    expect((await gumCalls(guest.page)).length).toBeGreaterThanOrEqual(1);
    await expect(guest.page.locator(tid(TID.permissionPrime))).not.toBeVisible();
    await expect(guest.page.locator(tid(TID.allowMedia))).not.toBeVisible();
  });

  test("blocked: help for this browser with Try again; after allowing, the preview comes back", async ({
    call,
  }) => {
    test.setTimeout(90_000);
    const host = await call.participant("Hana");
    const link = await newLink(host);
    // Fake devices WITHOUT the fake-UI flag + no granted permissions → the (headless) prompt is dismissed →
    // NotAllowedError. Full Chromium only: the headless shell rejects with NotSupportedError instead.
    const strict = await call.launchBrowser(["--use-fake-device-for-media-stream"], { channel: "chromium" });
    const guest = await call.participant("Gil", { browser: strict, contextOptions: { permissions: [] } });
    await countGetUserMedia(guest.context);
    // Never-asked reads "denied" in headless Chromium; read it as "prompt" like a real browser (Get ready first).
    await emulateUnaskedPermissions(guest.context);

    await expectGetReady(guest, link);
    await guest.page.locator(tid(TID.allowMedia)).click();
    await expect(guest.page.locator(tid(TID.permissionHelp))).toBeVisible();
    await expect(guest.page.locator(tid(TID.retryMedia))).toBeVisible();
    await expect(guest.page.locator(tid(TID.permissionPrime))).not.toBeVisible();
    const blocked = await qaState(guest.page);
    expect(blocked.phase).toBe("lobby");
    expect(blocked.error?.code).toBe("permission-denied");
    expect(blocked.local.mediaRequest).toBe("done");
    // One tap = at most one browser prompt (no per-device fallback after a combined NotAllowedError).
    expect(await gumCalls(guest.page), "getUserMedia calls for one tap").toHaveLength(1);
    // The join buttons stay available: never a dead end.
    await expect(guest.page.locator(tid(TID.joinButton))).toBeVisible();

    // The user re-enables camera+mic in the browser's settings, then taps "I've done it — try again". The controller
    // may already have re-acquired on the permission `change` event (auto-retry) — assert the end state, not the tap.
    await guest.context.grantPermissions(["camera", "microphone"], { origin: origin(guest.page) });
    const retry = guest.page.locator(tid(TID.retryMedia));
    if (await retry.isVisible()) await retry.click({ timeout: 2_000 }).catch(() => {});
    await expect(guest.page.locator(tid(TID.lobbyPreview))).toBeVisible();
    await expect(guest.page.locator(tid(TID.permissionHelp))).not.toBeVisible();
    await expect
      .poll(async () => {
        const s = await qaState(guest.page);
        return { req: s.local.mediaRequest, stream: !!s.local.stream, error: s.error };
      })
      .toEqual({ req: "done", stream: true, error: null });
  });

  test("join with sound only: the host hears the guest and gets no video from them", async ({ call }) => {
    test.setTimeout(90_000);
    const host = await call.participant("Hana");
    const guest = await call.participant("Gil", { contextOptions: { permissions: [] } });
    await countGetUserMedia(guest.context);
    await emulateUnaskedPermissions(guest.context);
    const link = await startCall(host);

    await expectGetReady(guest, link);
    // Allow on the (microphone-only) prompt.
    await guest.context.grantPermissions(["microphone"], { origin: origin(guest.page) });
    const name = guest.page.locator(tid(TID.nameInput));
    if (await name.isVisible()) await name.fill(guest.name);
    await guest.page.locator(tid(TID.joinSoundOnly)).click();
    await finishJoin(guest);
    await waitAllConnected([host, guest]);

    // Only the microphone was ever requested.
    const calls = await gumCalls(guest.page);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(
      calls.filter((c) => !!c.video),
      "getUserMedia calls asking for the camera",
    ).toEqual([]);
    const local = (await qaState(guest.page)).local;
    expect({ micOn: local.micOn, camOn: local.camOn }).toEqual({ micOn: true, camOn: false });

    // Host: the guest's audio arrives and is audible; their camera is off and no video frame ever decodes.
    await expectMediaFlowing(host.page, { video: false, label: host.name });
    await expectAudio(host.page);
    const seen = (await qaState(host.page)).participants[0]!;
    expect({ micOn: seen.micOn, camOn: seen.camOn }).toEqual({ micOn: true, camOn: false });
    const fromGuest = await onlyRemote(host.page);
    expect(fromGuest.video.framesDecoded ?? 0, "video frames from the sound-only guest").toBe(0);
    // The guest still sees and hears the host.
    await expectMediaFlowing(guest.page, { label: guest.name });
    await expectAudio(guest.page);
  });

  test("join and just listen from Get ready: the listener hears the host, nothing is requested", async ({
    call,
  }) => {
    test.setTimeout(90_000);
    const host = await call.participant("Hana");
    const guest = await call.participant("Gil", { contextOptions: { permissions: [] } });
    await countGetUserMedia(guest.context);
    await emulateUnaskedPermissions(guest.context);
    const link = await startCall(host);

    await expectGetReady(guest, link);
    // "Join and just listen" = the regular Join button while no device was granted.
    await guest.page.locator(tid(TID.nameInput)).fill(guest.name);
    await guest.page.locator(tid(TID.joinButton)).click();
    await expect(guest.page.locator(tid(TID.callScreen))).toBeVisible();
    await waitAllConnected([host, guest]);

    await expectMediaFlowing(guest.page, { video: false, label: guest.name });
    await expectAudio(guest.page);
    expect(await gumCalls(guest.page), "a listener never triggers a prompt").toEqual([]);
    const local = (await qaState(guest.page)).local;
    expect({ micOn: local.micOn, camOn: local.camOn }).toEqual({ micOn: false, camOn: false });
    const seen = (await qaState(host.page)).participants[0]!;
    expect({ micOn: seen.micOn, camOn: seen.camOn }).toEqual({ micOn: false, camOn: false });
  });
});

// Real-world in-app browser user agents (the app decides from the UA only).
const WHATSAPP_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36 WhatsApp/2.24.18.80";
const INSTAGRAM_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 " +
  "Instagram 345.0.0.34.92 (iPhone15,2; iOS 17_5; en_US; en; scale=3.00; 1179x2556; 634108188)";
const PHONE = { width: 390, height: 844 };

test.describe("permission coach — in-app browsers", () => {
  test("WhatsApp on Android: open in Chrome via an intent:// link that keeps the #secret, plus Copy link", async ({
    call,
  }) => {
    const host = await call.participant("Hana");
    const link = await newLink(host);
    const secret = secretOf(link);
    expect(secret.length).toBeGreaterThan(0);
    const guest = await call.participant("Gil", {
      contextOptions: { userAgent: WHATSAPP_ANDROID, viewport: PHONE, permissions: [] },
    });
    await countGetUserMedia(guest.context);
    await emulateUnaskedPermissions(guest.context);
    await guest.page.goto(withQa(link));

    await expect(guest.page.locator(tid(TID.inAppNotice))).toBeVisible();
    const open = guest.page.locator(tid(TID.openInBrowser)).first();
    await expect(open).toBeVisible();
    await expect(guest.page.locator(tid(TID.copyLink)).first()).toBeVisible();
    const href = (await open.getAttribute("href")) ?? "";
    expect(href, "intent URL").toMatch(/^intent:\/\//);
    expect(href.endsWith(";end"), `ends with ;end: ${href}`).toBe(true);
    expect(href).toContain("package=com.android.chrome");
    // Intent.parseUri splits on the LAST '#': the secret fragment sits right before '#Intent;' …
    expect(href).toContain(`#${secret}#Intent;`);
    expect(href.lastIndexOf("#"), "#Intent; is the last fragment").toBe(href.indexOf("#Intent;"));
    // … and never moves into the path or query (ADR-0004).
    expect(href.slice(0, href.indexOf("#")), "secret outside the fragment").not.toContain(secret);
    const fallback = /S\.browser_fallback_url=([^;]*)/.exec(href)?.[1];
    expect(fallback, "browser_fallback_url").toBeTruthy();
    expect(fallback!, "fallback is percent-encoded").not.toContain("#");
    expect(decodeURIComponent(fallback!)).toContain(`/c#${secret}`);
    // Opening the link inside WhatsApp prompts for nothing by itself.
    expect(await gumCalls(guest.page)).toEqual([]);
  });

  test("Instagram on iOS: Copy link (and Open in Safari) instead of a dead end", async ({ call }) => {
    const host = await call.participant("Hana");
    const link = await newLink(host);
    const secret = secretOf(link);
    const guest = await call.participant("Gil", {
      contextOptions: { userAgent: INSTAGRAM_IOS, viewport: PHONE, permissions: [] },
    });
    await countGetUserMedia(guest.context);
    await emulateUnaskedPermissions(guest.context);
    await guest.page.goto(withQa(link));

    // A lobby notice when the webview can still try, the error screen when it can't — either way: a way out.
    await expect(
      guest.page.locator(tid(TID.inAppNotice)).or(guest.page.locator(tid(TID.errorScreen))),
    ).toBeVisible();
    await expect(guest.page.locator(tid(TID.copyLink)).first()).toBeVisible();
    // iOS ≥ 17: "Open in Safari" through x-safari-https:// (review round 1, item 8), secret still in the fragment.
    const open = guest.page.locator(tid(TID.openInBrowser)).first();
    await expect(open).toBeVisible();
    const href = (await open.getAttribute("href")) ?? "";
    expect(href).toMatch(/^x-safari-https?:\/\//); // https in production, http on the local dev server
    expect(href.endsWith(`#${secret}`), `fragment kept: ${href}`).toBe(true);
    expect(await gumCalls(guest.page)).toEqual([]);
  });
});
