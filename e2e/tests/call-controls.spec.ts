/**
 * In-call controls are reflected on the remote side: mic mute (ctl `state` → micOn + tile data-mic)
 * and camera off/on (camOn + tile data-cam; video frames stop/resume without renegotiation).
 */
import {
  clickControl,
  expectMediaFlowing,
  remoteByName,
  remoteTile,
  setupCall,
  showControls,
} from "../lib/call.ts";
import { expect, test } from "../lib/fixtures.ts";
import { qaStats, TID, tid } from "../lib/qa.ts";

const OFF = /^(off|false|0)$/;
const ON = /^(on|true|1)$/;

test.describe("controls reflected remotely", () => {
  test("2-party video: the dock auto-hides and a mouse move reveals it", async ({ call }) => {
    const [alice, bob] = await call.participants("Alice", "Bob");
    await setupCall([alice!, bob!]);
    const screen = alice!.page.locator(tid(TID.callScreen));
    // AUTO_HIDE_MS is 4 s after the last input; allow generous slack.
    await expect(screen).toHaveClass(/\bis-chrome-hidden\b/, { timeout: 10_000 });
    await showControls(alice!.page);
    await expect(screen).not.toHaveClass(/\bis-chrome-hidden\b/);
    await expect(alice!.page.locator(tid(TID.micToggle))).toBeEnabled();
  });

  test("mute and unmute is shown to the other side", async ({ call }) => {
    const [alice, bob] = await call.participants("Alice", "Bob");
    await setupCall([alice!, bob!]);

    await clickControl(alice!.page, TID.micToggle);
    await expect.poll(async () => (await remoteByName(bob!.page, "Alice"))?.micOn).toBe(false);
    await expect(remoteTile(bob!.page, "Alice")).toHaveAttribute("data-mic", OFF);
    // Muting must not tear the call down: video keeps flowing.
    await expectMediaFlowing(bob!.page);

    await clickControl(alice!.page, TID.micToggle);
    await expect.poll(async () => (await remoteByName(bob!.page, "Alice"))?.micOn).toBe(true);
    await expect(remoteTile(bob!.page, "Alice")).toHaveAttribute("data-mic", ON);
  });

  test("camera off and on is shown to the other side", async ({ call }) => {
    const [alice, bob] = await call.participants("Alice", "Bob");
    await setupCall([alice!, bob!]);
    await expectMediaFlowing(bob!.page);

    await clickControl(alice!.page, TID.camToggle);
    await expect.poll(async () => (await remoteByName(bob!.page, "Alice"))?.camOn).toBe(false);
    await expect(remoteTile(bob!.page, "Alice")).toHaveAttribute("data-cam", OFF);
    // Video frames stop arriving (sender track null) while audio continues.
    await expectMediaFlowing(bob!.page, { video: false });
    let last = -1;
    let changedAt = Date.now();
    await expect
      .poll(
        async () => {
          const frames = (await qaStats(bob!.page))[0]?.video.framesDecoded ?? 0;
          if (frames !== last) {
            last = frames;
            changedAt = Date.now();
          }
          return Date.now() - changedAt;
        },
        { message: "ms since remote video framesDecoded last changed", timeout: 15_000, intervals: [250] },
      )
      .toBeGreaterThanOrEqual(2000);

    await clickControl(alice!.page, TID.camToggle);
    await expect.poll(async () => (await remoteByName(bob!.page, "Alice"))?.camOn).toBe(true);
    await expect(remoteTile(bob!.page, "Alice")).toHaveAttribute("data-cam", ON);
    await expectMediaFlowing(bob!.page, { timeout: 15_000 });
  });
});
