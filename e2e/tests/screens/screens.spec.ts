/**
 * Screenshot suite (`make screenshots`): every FakeCallController scenario × {iPhone 15, Pixel 7, 1440×900}.
 * Machine-checked per shot: PNG written, no horizontal overflow, required testids visible, axe color-contrast = 0.
 * The PNGs in quality/reports/screens/ are for human/agent visual review (ui-verify).
 */
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { TID } from "../../../web/src/core/testids.ts";
import { DEVICES, type DeviceSpec, SCENARIOS, type ScreenScenario } from "./scenarios.ts";

test.describe.configure({ mode: "parallel" });

for (const device of DEVICES) {
  test.describe(device.name, () => {
    for (const sc of SCENARIOS) {
      test(`${sc.name} @ ${device.name}`, async ({ browser }, testInfo) => {
        const context = await browser.newContext({
          ...device.options,
          baseURL: testInfo.project.use.baseURL,
          colorScheme: sc.colorScheme ?? "dark",
          reducedMotion: "reduce",
          permissions: ["camera", "microphone"],
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        try {
          await page.goto(`/?fake=1&scenario=${sc.scenario ?? sc.name}`);
          await simulateSafeArea(page, device);
          const ids = await expectRequired(page, sc, device);
          await waitForVideos(page);
          await expectInViewport(page, ids);
          await expectTilesClearOfChrome(page);

          const file = path.join(
            testInfo.config.rootDir,
            "../../quality/reports/screens",
            `${sc.name}-${device.name}.png`,
          );
          await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
          await testInfo.attach("screenshot", { path: file, contentType: "image/png" });

          const overflow = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
          }));
          expect(overflow.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(overflow.innerWidth);

          const axe = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
          const report = axe.violations.flatMap((v) =>
            v.nodes.map((n) => `${n.target.join(" ")}: ${n.failureSummary}`),
          );
          expect(report, "axe color-contrast violations").toEqual([]);
          expect(errors, "page errors").toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  });
}

async function simulateSafeArea(page: Page, device: DeviceSpec) {
  const sa = device.safeArea;
  if (!sa) return;
  const island = sa.island
    ? `html::before{content:"";position:fixed;z-index:2147483647;top:11px;left:50%;width:124px;height:36px;margin-left:-62px;border-radius:20px;background:#000;pointer-events:none}`
    : "";
  await page.addStyleTag({
    content: `:root{--safe-top:${sa.top}px;--safe-bottom:${sa.bottom}px}${island}html::after{content:"";position:fixed;z-index:2147483647;bottom:8px;left:50%;width:134px;height:5px;margin-left:-67px;border-radius:3px;background:rgb(255 255 255 / .6);pointer-events:none}`,
  });
}

async function expectRequired(page: Page, sc: ScreenScenario, device: DeviceSpec) {
  const ids = [
    ...sc.required,
    ...(device.mobile ? (sc.requiredMobile ?? []) : []),
    ...(device.name === "iphone15" ? (sc.requiredIos ?? []) : []),
  ];
  for (const id of ids) await expect(page.getByTestId(id).first(), `testid ${id}`).toBeVisible();
  if (sc.tiles !== undefined) await expect(page.getByTestId(TID.participantTile)).toHaveCount(sc.tiles);
  return ids;
}

/** Required controls must be on screen without scrolling (thumb reach, nothing pushed below the fold). */
async function expectInViewport(page: Page, ids: string[]) {
  const vh = page.viewportSize()!.height;
  const containers = new Set<string>([
    TID.lobby,
    TID.lobbyPreview,
    TID.callScreen,
    TID.endedScreen,
    TID.errorScreen,
  ]);
  for (const id of ids.filter((i) => !containers.has(i))) {
    const box = await page.getByTestId(id).first().boundingBox();
    expect(box, `testid ${id} has a box`).not.toBeNull();
    expect(box!.y + box!.height, `testid ${id} within the viewport`).toBeLessThanOrEqual(vh + 0.5);
  }
}

/** In grid layouts no tile may sit under the header pill or the control dock. */
async function expectTilesClearOfChrome(page: Page) {
  const bad = await page.evaluate(() => {
    const layout = document.querySelector<HTMLElement>("[data-layout]")?.dataset.layout;
    if (layout !== "grid" && layout !== "spotlight") return [];
    const chrome = [".call__status", ".controls"]
      .map((s) => document.querySelector(s)?.getBoundingClientRect())
      .filter((r): r is DOMRect => !!r);
    const hits: string[] = [];
    for (const t of document.querySelectorAll<HTMLElement>(".tile")) {
      const a = t.getBoundingClientRect();
      for (const b of chrome)
        if (a.left < b.right && b.left < a.right && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5)
          hits.push(t.dataset.name ?? t.dataset.participantId ?? "?");
    }
    return hits;
  });
  expect(bad, "tiles overlapping header/controls").toEqual([]);
}

async function waitForVideos(page: Page) {
  await page.waitForFunction(
    () => [...document.querySelectorAll("video")].every((v) => v.readyState >= 2 && v.videoWidth > 0),
    undefined,
    { timeout: 10_000 },
  );
  // Let ResizeObserver-driven layout settle (safe-area change → header height → tile rects).
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
