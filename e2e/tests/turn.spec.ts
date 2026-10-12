/**
 * TURN relay check — runs only with CLEARCALL_TURN=1 against a deployment that has TURN secrets (`make turn-check`).
 * Both participants use `?relay=1` (iceTransportPolicy "relay"), so media can only flow through the TURN server.
 */
import { expectMediaFlowing, joinFromLobby, type Participant, waitAllConnected } from "../lib/call.ts";
import { expect, test } from "../lib/fixtures.ts";
import { qaState, qaStats, TID, tid } from "../lib/qa.ts";

const relay = (url: string) => {
  const u = new URL(url, "http://x");
  u.searchParams.set("qa", "1");
  u.searchParams.set("relay", "1");
  return /^https?:/.test(url) ? u.toString() : `${u.pathname}${u.search}${u.hash}`;
};

async function relayCall(alice: Participant, bob: Participant) {
  await alice.page.goto(relay("/"));
  await alice.page.locator(tid(TID.startCall)).click();
  await joinFromLobby(alice);
  const link = (await qaState(alice.page)).link!;
  await bob.page.goto(relay(link));
  await joinFromLobby(bob);
}

test.describe("relay-only without TURN", () => {
  test("never connects (proves ?relay=1 forbids direct routes)", async ({ call, request }) => {
    const { turn } = (await (await request.get("/api/health")).json()) as { turn?: boolean };
    test.skip(turn === true, "this deployment has TURN");
    const [alice, bob] = await call.participants("Alice", "Bob");
    await relayCall(alice!, bob!);
    // Direct candidates would connect in < 2 s on localhost; give it ample time to prove they're never used.
    await alice!.page.waitForTimeout(8_000);
    for (const p of [alice!, bob!]) {
      const peers = await qaStats(p.page);
      expect(
        peers.every((s) => s.connectionState !== "connected"),
        `${p.name} must not connect`,
      ).toBe(true);
    }
  });
});

test.describe("TURN relay", () => {
  test.skip(process.env.CLEARCALL_TURN !== "1", "needs a TURN-enabled deployment: make turn-check URL=…");

  test("health says TURN is configured", async ({ request }) => {
    expect(await (await request.get("/api/health")).json()).toMatchObject({ ok: true, turn: true });
  });

  test("relay-only 2-party call connects through TURN and media flows", async ({ call }) => {
    const [alice, bob] = await call.participants("Alice", "Bob");
    await relayCall(alice!, bob!);
    await waitAllConnected([alice!, bob!], 30_000);
    for (const p of [alice!, bob!]) {
      await expectMediaFlowing(p.page);
      const peers = await qaStats(p.page);
      expect(
        peers.map((s) => s.candidateType),
        `${p.name} route`,
      ).toEqual(["relay"]);
    }
  });
});
