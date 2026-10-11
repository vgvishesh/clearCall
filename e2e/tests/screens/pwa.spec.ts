/** PWA shell checks + a fake-engine click-through of the main flow (runs in the `screens` project). */
import { expect, test } from "@playwright/test";
import { TID } from "../../../web/src/core/testids.ts";

test("service worker controls the page after reload", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
});

test("manifest is linked and installable-shaped", async ({ page, request }) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBeTruthy();
  const m = await (await request.get(href!)).json();
  expect(m).toMatchObject({
    name: "Clearcall",
    short_name: "Clearcall",
    display: "standalone",
    start_url: "/",
  });
  for (const icon of m.icons as { src: string }[])
    expect((await request.get(`/${icon.src}`)).ok()).toBe(true);
});

test("security headers on the app shell and call links", async ({ request }) => {
  for (const path of ["/", "/c"]) {
    const h = (await request.get(path)).headers();
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["content-security-policy"]).toContain("script-src 'self'");
    expect(h["permissions-policy"]).toContain("camera=(self)");
    expect(h["referrer-policy"]).toBe("no-referrer");
  }
});

test("no CSP violations while running the call UI", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await page.goto("/?fake=1&scenario=call-4");
  await expect(page.getByTestId(TID.participantTile)).toHaveCount(3);
  expect(violations).toEqual([]);
});

test("fake flow: start → lobby → join → call → leave → ended → new call", async ({ page }) => {
  await page.goto("/?fake=1&scenario=home");
  await page.getByTestId(TID.startCall).click();
  await expect(page.getByTestId(TID.lobby)).toBeVisible();
  await expect(page).toHaveURL(/\/c\?fake=1&scenario=home#.+/);
  await page.getByTestId(TID.nameInput).fill("Sam");
  await page.getByTestId(TID.joinButton).click();
  await expect(page.getByTestId(TID.callScreen)).toBeVisible();
  await expect(page.getByTestId(TID.participantTile)).toHaveCount(1);
  await page.getByTestId(TID.camToggle).click();
  await expect(page.getByTestId(TID.selfTile)).toHaveAttribute("data-cam", "false");
  await expect(page.getByTestId(TID.selfTile)).toHaveAttribute("data-participant-id", "self");
  await page.getByTestId(TID.moreMenu).click();
  await page.getByTestId(TID.sheetClose).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByTestId(TID.leaveButton).click();
  await expect(page.getByTestId(TID.endedScreen)).toBeVisible();
  await page.getByTestId(TID.newCallButton).click();
  await expect(page.getByTestId(TID.lobby)).toBeVisible();
});
