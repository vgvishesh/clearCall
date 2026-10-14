/**
 * Weak devices (ADR-0010; bug report 2026-10-14: iPhone ⇄ old Android 1:1 went choppy → frozen → robotic audio).
 * - A constrained device (phone / ≤ 2 cores / ≤ 4 GB; `?devclass=constrained` emulates one) never negotiates
 *   software AV1/VP9, in either direction, whichever side answers.
 * - CPU overload guard: a starved sender (QA fault `cpu-overload` feeds the guard overloaded samples) drops the
 *   heavy codec and steps to ≤ 360p 15 fps both ways, then pauses video both ways — audio keeps flowing.
 */
import type { Page } from "@playwright/test";
import { expectAudio, expectMediaFlowing, joinFromLobby, startCall, waitAllConnected } from "../lib/call.ts";
import { expect, test } from "../lib/fixtures.ts";
import { qaInject, qaState, qaStats, withQa } from "../lib/qa.ts";

/** Join with extra app flags (query before the #secret). */
async function joinWithFlags(
  page: Page,
  link: string,
  flags: string,
  p: Parameters<typeof joinFromLobby>[0],
) {
  const u = new URL(withQa(link));
  for (const [k, v] of new URLSearchParams(flags)) u.searchParams.set(k, v);
  await page.goto(u.toString());
  await joinFromLobby(p);
}

const videoCodec = async (page: Page) => (await qaStats(page))[0]?.video.codec;

test.describe("weak devices (ADR-0010)", () => {
  test("a constrained device keeps software AV1/VP9 out of both directions", async ({
    call,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "codec negotiation checked on Chromium (AV1 software encoder)");
    test.setTimeout(90_000);
    const [host, guest] = await call.participants("Host", "Phone");
    const link = await startCall(host!);
    await joinWithFlags(guest!.page, link, "devclass=constrained", guest!); // the joiner offers
    await waitAllConnected([host!, guest!], 30_000);
    await expectMediaFlowing(host!.page);
    await expectMediaFlowing(guest!.page);
    for (const p of [host!, guest!]) {
      await expect.poll(() => videoCodec(p.page), { message: `${p.name} codec` }).toMatch(/^(VP8|H264)$/);
      const s = (await qaStats(p.page))[0]!;
      expect(s.video.codec, `${p.name} must not send or receive AV1/VP9`).not.toMatch(/AV1|VP9/);
    }
    for (const p of call.all) expect(p.diag.pageErrors, `${p.name} page errors`).toEqual([]);
  });

  test("CPU overload: heavy codec dropped + reduced, then video paused both ways while audio flows", async ({
    call,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "guard inputs (encode time) are Chromium stats");
    test.setTimeout(120_000);
    const [host, guest] = await call.participants("Host", "Laptop");
    const link = await startCall(host!);
    await joinWithFlags(guest!.page, link, "", guest!);
    await waitAllConnected([host!, guest!], 30_000);
    await expectMediaFlowing(host!.page);
    await expect.poll(() => videoCodec(guest!.page), { message: "1:1 starts on AV1" }).toBe("AV1");

    await qaInject(guest!.page, "cpu-overload");
    // Step 1 (~10 s): VP8/H264 both ways, ≤ 360p at ≤ 15 fps from the starved side, and it asks for ≤ 360p.
    await expect
      .poll(async () => (await qaState(guest!.page)).videoLimited, { timeout: 25_000 })
      .toBe("reduced");
    await expect.poll(() => videoCodec(guest!.page), { timeout: 15_000 }).toMatch(/^(VP8|H264)$/);
    await expect
      .poll(async () => (await qaStats(guest!.page))[0]?.video.sentFrameHeight ?? 0, { timeout: 15_000 })
      .toBeLessThanOrEqual(360);
    await expect
      .poll(async () => (await qaStats(host!.page))[0]?.video.sentFrameHeight ?? 999, { timeout: 15_000 })
      .toBeLessThanOrEqual(360);
    await expectMediaFlowing(host!.page, { label: "host, reduced" });

    // Step 2 (~10 s more): video paused both ways; the host sees the camera as off; audio keeps flowing.
    await expect
      .poll(async () => (await qaState(guest!.page)).videoLimited, { timeout: 25_000 })
      .toBe("paused");
    await expect
      .poll(async () => (await qaState(host!.page)).participants[0]?.camOn, { timeout: 10_000 })
      .toBe(false);
    await expectMediaFlowing(host!.page, { video: false, label: "host, paused" });
    await expectMediaFlowing(guest!.page, { video: false, label: "guest, paused" });
    await expectAudio(host!.page);
    await expectAudio(guest!.page);
    for (const p of call.all) expect(p.diag.pageErrors, `${p.name} page errors`).toEqual([]);
  });
});
