/**
 * Error states: malformed links and camera/mic permission denied.
 */
import { allowMediaIfAsked } from "../lib/call.ts";
import { expect, test } from "../lib/fixtures.ts";
import { emulateUnaskedPermissions } from "../lib/permissions.ts";
import { qaState, TID, tid, withQa } from "../lib/qa.ts";

test.describe("error states", () => {
  for (const [label, path] of [
    ["malformed secret", "/c#not-a-valid-secret!"],
    ["missing secret", "/c"],
  ] as const) {
    test(`invalid link (${label}) shows the error screen`, async ({ call }) => {
      const p = await call.participant("Zoe");
      await p.page.goto(withQa(path));
      await expect(p.page.locator(tid(TID.errorScreen))).toBeVisible();
      await expect(p.page.locator(tid(TID.errorCode))).toContainText("invalid-link");
      const s = await qaState(p.page);
      expect(s.phase).toBe("error");
      expect(s.error?.code).toBe("invalid-link");
    });
  }

  test("permission denied keeps the lobby with an inline error", async ({ call, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "relies on Chromium launch flags to separate fake devices from fake UI",
    );
    // Separate browser WITH fake devices but WITHOUT --use-fake-ui-for-media-stream, and a context with no granted
    // permissions, so the permission prompt is auto-dismissed → getUserMedia rejects with NotAllowedError.
    // Must be the full Chromium in new-headless mode (`channel: "chromium"`): Playwright's default
    // chromium-headless-shell has no permission-prompt UI and rejects with NotSupportedError instead (→ no-devices).
    const browser = await call.launchBrowser(["--use-fake-device-for-media-stream"], { channel: "chromium" });
    const p = await call.participant("Nia", { browser, contextOptions: { permissions: [] } });
    // Headless Chromium reads never-asked camera/mic as "denied" (the app would skip straight to the blocked help
    // without calling getUserMedia); read them as "prompt" like a real browser so the tap really asks and is refused.
    await emulateUnaskedPermissions(p.context);

    await p.page.goto(withQa("/"));
    await p.page.locator(tid(TID.startCall)).click();
    await expect(p.page.locator(tid(TID.lobby))).toBeVisible();
    // Permission coach: no prompt without a tap — tap "Turn on camera & mic" if the Get ready step shows.
    await allowMediaIfAsked(p.page);
    await expect
      .poll(async () => (await qaState(p.page)).error?.code, { timeout: 10_000 })
      .toBe("permission-denied");
    const s = await qaState(p.page);
    expect(s.phase).toBe("lobby");
    expect(s.local.camAvailable && s.local.micAvailable).toBe(false);
    // Evidence that the browser really denied (not "no device"): the media module logs the DOMException name.
    expect(p.diag.format()).toContain("NotAllowedError");
  });
});
