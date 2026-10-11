/**
 * Leaving, rejoining and reloading (FLOWS.md §3 leave, §5 reload = new participant).
 */
import { RESUME_GRACE_SECONDS } from "@clearcall/protocol";
import { clickControl, expectMediaFlowing, joinFromLobby, setupCall, waitAllConnected } from "../lib/call.ts";
import { expect, test } from "../lib/fixtures.ts";
import { qaState, TID, tid, withQa } from "../lib/qa.ts";

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

  test("reload mid-call rejoins as a new participant; old tile gone ≤ 20 s", async ({ call }) => {
    test.setTimeout(90_000);
    const [alice, bob] = await call.participants("Alice", "Bob");
    await setupCall([alice!, bob!]);
    const oldId = (await qaState(alice!.page)).participants[0]?.id;
    expect(oldId).toBeTruthy();

    // A reload is a fresh document. If the app's replaceState dropped ?qa=1, navigating to the same URL with it
    // re-added is equivalent (new page load, pagehide fires on the old one).
    const url = bob!.page.url();
    const qaUrl = withQa(url);
    if (qaUrl === url) await bob!.page.reload();
    else await bob!.page.goto(qaUrl);
    await joinFromLobby(bob!); // name is remembered, but fill is idempotent

    // FLOWS §5: the old peerId leaves immediately when pagehide delivered `leave`, otherwise it times out after the
    // resume grace window (server alarm → peer-left{timeout}). Firefox does not deliver `leave` on reload, so there
    // the reloaded tab sees its own old peerId as a nameless "connecting" participant until the grace expires.
    // Allow the grace window plus alarm slack, and check BOTH sides.
    const graceMs = RESUME_GRACE_SECONDS * 1000 + 5_000;
    await expect
      .poll(async () => (await qaState(alice!.page)).participants.map((r) => r.id), {
        timeout: graceMs,
        message: "Alice: old peerId removed and exactly one new participant present",
      })
      .toEqual([expect.not.stringMatching(`^${oldId}$`)]);
    // Names arrive with hello, so anything not (yet) named Alice is listed by peerId — the ghost shows as `oldId`.
    await expect
      .poll(
        async () => (await qaState(bob!.page)).participants.map((r) => (r.name === "Alice" ? "Alice" : r.id)),
        { timeout: graceMs, message: "reloaded Bob: only Alice remains (his own old peerId is gone)" },
      )
      .toEqual(["Alice"]);
    await waitAllConnected([alice!, bob!]);
    await expectMediaFlowing(alice!.page);
    await expectMediaFlowing(bob!.page);
  });
});
