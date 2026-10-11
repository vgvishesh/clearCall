/**
 * Signaling drop (FLOWS.md §4): the socket dies, media keeps flowing P2P, the client resumes within the
 * grace window without anyone seeing a peer-left.
 */
import { expectMediaFlowing, setupCall, waitAllConnected } from "../lib/call.ts";
import { expect, test } from "../lib/fixtures.ts";
import { qaInject, qaState } from "../lib/qa.ts";

test.describe("resilience", () => {
  test("signaling drop: call survives and the client resumes", async ({ call }) => {
    test.setTimeout(90_000);
    const [alice, bob] = await call.participants("Alice", "Bob");
    await setupCall([alice!, bob!]);
    const aliceIdSeenByBob = (await qaState(bob!.page)).participants[0]?.id;

    await qaInject(alice!.page, "drop-signaling");
    // Media is P2P: it must keep flowing while signaling is down.
    await expectMediaFlowing(bob!.page);
    await expectMediaFlowing(alice!.page);

    // Alice resumes (phase back to in-call) and Bob never saw her leave (same peerId, no rebuild).
    await expect.poll(async () => (await qaState(alice!.page)).phase, { timeout: 30_000 }).toBe("in-call");
    expect((await qaState(bob!.page)).participants.map((r) => r.id)).toEqual([aliceIdSeenByBob]);
    await waitAllConnected([alice!, bob!]);

    const logs = await alice!.page.evaluate(() => window.__clearcall?.logs() ?? []);
    expect(
      logs.some((l) => l.scope === "signaling"),
      "signaling module logs its reconnect",
    ).toBe(true);
    for (const p of call.all) expect(p.diag.pageErrors, `${p.name} page errors`).toEqual([]);
  });

  test("ICE restart keeps media flowing", async ({ call }) => {
    const [alice, bob] = await call.participants("Alice", "Bob");
    await setupCall([alice!, bob!]);
    const bobId = (await qaState(alice!.page)).participants[0]!.id;
    await qaInject(alice!.page, "restart-ice", bobId);
    await waitAllConnected([alice!, bob!], 20_000);
    await expectMediaFlowing(alice!.page);
    await expectMediaFlowing(bob!.page);
  });
});
