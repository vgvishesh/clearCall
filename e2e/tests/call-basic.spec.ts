/**
 * Core mesh calls: 2, 3 and 4 participants exchanging real (fake-device) media.
 */
import { expectAudio, expectMediaFlowing, setupCall } from "../lib/call.ts";
import { expect, test } from "../lib/fixtures.ts";
import { qaState, TID, tid } from "../lib/qa.ts";

test.describe("mesh calls", () => {
  test("two-party call: both connect, see and hear each other", async ({ call }) => {
    const [alice, bob] = await call.participants("Alice", "Bob");
    await setupCall([alice!, bob!]);
    for (const p of [alice!, bob!]) {
      await expectMediaFlowing(p.page);
      await expectAudio(p.page);
      await expect(p.page.locator(tid(TID.participantTile))).toHaveCount(1);
    }
    // Names travel over the encrypted hello/state messages.
    expect((await qaState(alice!.page)).participants[0]?.name).toBe("Bob");
    expect((await qaState(bob!.page)).participants[0]?.name).toBe("Alice");
    // No page errors during a clean call.
    for (const p of call.all) expect(p.diag.pageErrors, `${p.name} page errors`).toEqual([]);
  });

  for (const n of [3, 4]) {
    test(`${n}-party mesh: everyone receives everyone`, async ({ call, browserName }) => {
      test.skip(
        browserName !== "chromium" && n > 3,
        "multi-party in one shared non-Chromium browser is CPU-bound",
      );
      test.setTimeout(120_000);
      const names = ["Alice", "Bob", "Carol", "Dave"].slice(0, n);
      const ps = await call.participants(...names);
      await setupCall(ps, 30_000);
      await Promise.all(ps.map((p) => expectMediaFlowing(p.page, { timeout: 20_000, label: p.name })));
      for (const p of ps) {
        await expectAudio(p.page, { timeout: 20_000 });
        await expect(p.page.locator(tid(TID.participantTile))).toHaveCount(n - 1);
        await expect(p.page.locator(tid(TID.participantCount))).toContainText(String(n));
      }
      for (const p of call.all) expect(p.diag.pageErrors, `${p.name} page errors`).toEqual([]);
    });
  }
});
