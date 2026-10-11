/**
 * Capacity: a full 10-party mesh, and the 11th participant is refused with room-full (away peers count — FLOWS.md §7).
 *
 * Runs only in the `capacity` project (one worker, after every other project — see playwright.config.ts).
 * All participants are contexts of ONE Chromium: 10 separate Chromium processes thermally throttle a laptop host
 * (load average in the hundreds, signaling sockets declared dead), while one browser with 10 contexts connects the
 * full mesh in seconds. Each participant still has its own context (separate storage, own fake devices).
 */
import type { Participant } from "../lib/call.ts";
import { expectMediaFlowing, joinFromLobby, setupCall } from "../lib/call.ts";
import { expect, test } from "../lib/fixtures.ts";
import { qaState, TID, tid, withQa } from "../lib/qa.ts";

/** In the lobby: camera off (polled until the controller reflects it), then join. */
async function joinCameraOff(p: Participant): Promise<void> {
  await expect(p.page.locator(tid(TID.lobby))).toBeVisible();
  await expect.poll(async () => (await qaState(p.page)).local.stream !== null).toBe(true);
  await p.page.locator(`${tid(TID.lobby)} ${tid(TID.camToggle)}`).click();
  await expect.poll(async () => (await qaState(p.page)).local.camOn).toBe(false);
  await joinFromLobby(p);
}

const NAMES = ["Ana", "Ben", "Cai", "Dev", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jo"];

test.describe("capacity", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(({ browserName }) => browserName !== "chromium", "10-party mesh with fake media: Chromium only");

  test("10-party mesh: everyone connects and receives media", async ({ call }) => {
    test.setTimeout(240_000);
    const ps = await call.participants(...NAMES);
    await setupCall(ps, 90_000);
    await Promise.all(ps.map((p) => expectMediaFlowing(p.page, { timeout: 60_000, windowMs: 3000 })));
    for (const p of ps) await expect(p.page.locator(tid(TID.participantTile))).toHaveCount(9);
    for (const p of call.all) expect(p.diag.pageErrors, `${p.name} page errors`).toEqual([]);
  });

  test("11th participant gets room-full", async ({ call }) => {
    test.setTimeout(180_000);
    const ps: Participant[] = await call.participants(...NAMES);
    // Fill the room; full mesh connectivity is covered above — here we only need 10 joined sockets. Everyone joins
    // with the camera off (lobby toggle) so 90 video encodes don't starve the host and the local worker: under that
    // load the 11th socket's upgrade exceeded the client's 10 s connect timeout.
    const host = ps[0]!;
    await host.page.goto(withQa("/"));
    await host.page.locator(tid(TID.startCall)).click();
    await joinCameraOff(host);
    const link = (await qaState(host.page)).link!;
    expect(link).toBeTruthy();
    for (const p of ps.slice(1)) {
      await p.page.goto(withQa(link));
      await joinCameraOff(p);
    }
    await expect
      .poll(async () => (await qaState(host.page)).participants.length, { timeout: 90_000 })
      .toBe(9);

    const eleventh = await call.participant("Kim");
    await eleventh.page.goto(withQa(link));
    await expect(eleventh.page.locator(tid(TID.lobby))).toBeVisible();
    await eleventh.page.locator(tid(TID.nameInput)).fill("Kim");
    await eleventh.page.locator(tid(TID.joinButton)).click();
    // Allow one client connect timeout (10 s) + backoff + retry on a loaded host before room-full arrives.
    await expect(eleventh.page.locator(tid(TID.errorScreen))).toBeVisible({ timeout: 30_000 });
    await expect(eleventh.page.locator(tid(TID.errorCode))).toContainText("room-full");
    const s = await qaState(eleventh.page);
    expect(s.phase).toBe("error");
    expect(s.error?.code).toBe("room-full");
    // The ten are unaffected.
    expect((await qaState(ps[0]!.page)).participants.length).toBe(9);
  });
});
