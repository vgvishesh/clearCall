/**
 * Leaving, rejoining and reloading (FLOWS.md §3 leave, §5 reload = new participant).
 */
import { RESUME_GRACE_SECONDS } from "@clearcall/protocol";
import { clickControl, expectMediaFlowing, joinFromLobby, setupCall, waitAllConnected } from "../lib/call.ts";
import { expect, test } from "../lib/fixtures.ts";
import { qaLogs, qaState, TID, tid, withQa } from "../lib/qa.ts";

test.describe("call lifecycle", () => {
  test("leave: others see the peer removed promptly", async ({ call }) => {
    const [alice, bob, carol] = await call.participants("Alice", "Bob", "Carol");
    await setupCall([alice!, bob!, carol!]);

    await clickControl(carol!.page, TID.leaveButton);
    await expect(carol!.page.locator(tid(TID.endedScreen))).toBeVisible();
    expect((await qaState(carol!.page)).phase).toBe("ended");

    // `leave` → server broadcasts peer-left{left} immediately: well under the 20 s resume grace.
    for (const p of [alice!, bob!]) {
      await expect
        .poll(async () => (await qaState(p.page)).participants.map((r) => r.name), { timeout: 5_000 })
        .not.toContain("Carol");
      await expect(p.page.locator(tid(TID.participantTile))).toHaveCount(1);
    }
    // The remaining pair is unaffected.
    await expectMediaFlowing(alice!.page);
    await expectMediaFlowing(bob!.page);
  });

  test("rejoin after leave reconnects with media", async ({ call }) => {
    const [alice, bob] = await call.participants("Alice", "Bob");
    await setupCall([alice!, bob!]);
    const firstId = (await qaState(alice!.page)).participants[0]?.id;

    await clickControl(bob!.page, TID.leaveButton);
    await expect(bob!.page.locator(tid(TID.endedScreen))).toBeVisible();
    await expect.poll(async () => (await qaState(alice!.page)).participants.length).toBe(0);

    await bob!.page.locator(tid(TID.rejoinButton)).click();
    await joinFromLobby(bob!);
    await waitAllConnected([alice!, bob!]);
    const rejoined = (await qaState(alice!.page)).participants[0];
    expect(rejoined?.name).toBe("Bob");
    expect(rejoined?.id, "rejoin is a fresh peerId").not.toBe(firstId);
    await expectMediaFlowing(alice!.page);
    await expectMediaFlowing(bob!.page);
  });

  test("reload mid-call rejoins as a new participant; the reloader never shows its own ghost", async ({
    call,
  }) => {
    test.setTimeout(90_000);
    const [alice, bob] = await call.participants("Alice", "Bob");
    await setupCall([alice!, bob!]);
    const oldId = (await qaState(alice!.page)).participants[0]?.id;
    expect(oldId).toBeTruthy();

    // Records, from the first moment of the reloaded document, every remote id the engine ever exposed in
    // CallState.participants and the most participant tiles ever in the DOM (MutationObserver: catches a tile even
    // if it was never painted).
    await bob!.page.addInitScript(() => {
      const probe = { ids: [] as string[], maxTiles: 0 };
      (window as unknown as { __ghostProbe: typeof probe }).__ghostProbe = probe;
      const sample = () => {
        for (const p of window.__clearcall?.state().participants ?? [])
          if (!probe.ids.includes(p.id)) probe.ids.push(p.id);
        const n = document.querySelectorAll('[data-testid="participant-tile"]').length;
        if (n > probe.maxTiles) probe.maxTiles = n;
      };
      new MutationObserver(sample).observe(document, { childList: true, subtree: true, attributes: true });
      const frame = () => {
        sample();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });

    // A reload is a fresh document. If the app's replaceState dropped ?qa=1, navigating to the same URL with it
    // re-added is equivalent (new page load, pagehide fires on the old one).
    const url = bob!.page.url();
    const qaUrl = withQa(url);
    if (qaUrl === url) await bob!.page.reload();
    else await bob!.page.goto(qaUrl);
    await joinFromLobby(bob!); // name is remembered, but fill is idempotent
    await waitAllConnected([alice!, bob!]);

    // FLOWS §5: the old peerId leaves at once when pagehide delivered `leave`. Firefox closes the socket (1001)
    // before pagehide, so there the server keeps it "away" for the grace window and lists it in the reloader's
    // welcome.peers; the reloader hides such a never-heard peer once the server answers unknown-peer (FLOWS §4).
    // Alice drops the old id at once either way (`leave`, or the ctl `bye` sent on pagehide).
    await expect
      .poll(async () => (await qaState(alice!.page)).participants.map((r) => r.id), {
        timeout: 5_000,
        message: "Alice: old peerId removed and exactly one new participant present",
      })
      .toEqual([expect.not.stringMatching(`^${oldId}$`)]);
    expect((await qaState(bob!.page)).participants.map((r) => r.name)).toEqual(["Alice"]);
    // If the server still listed the old id (Firefox), wait for its timeout to reach the reloader: the ghost must
    // never have surfaced in between (checked by the probe below).
    const ghost = oldId!.slice(0, 6);
    const bobLogs = () => qaLogs(bob!.page);
    const sawGhost = (await bobLogs()).some((l) => l.msg === "peer learned" && l.data?.peer === ghost);
    if (sawGhost) {
      await expect
        .poll(async () => (await bobLogs()).some((l) => l.msg === "peer left" && l.data?.peer === ghost), {
          timeout: RESUME_GRACE_SECONDS * 1000 + 5_000,
          message: "reloaded Bob: the server times out the old peerId",
        })
        .toBe(true);
    }
    expect((await qaState(bob!.page)).participants.map((r) => r.name)).toEqual(["Alice"]);
    const probe = await bob!.page.evaluate(
      () => (window as unknown as { __ghostProbe: { ids: string[]; maxTiles: number } }).__ghostProbe,
    );
    const aliceId = (await qaState(bob!.page)).participants[0]!.id;
    expect(probe.ids, "reloaded Bob never listed anyone but Alice").toEqual([aliceId]);
    expect(probe.maxTiles, "reloaded Bob never rendered more than Alice's tile").toBe(1);
    await expectMediaFlowing(alice!.page);
    await expectMediaFlowing(bob!.page);
  });
});
