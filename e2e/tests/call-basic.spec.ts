/**
 * Core mesh calls: 2, 3 and 4 participants exchanging real (fake-device) media.
 */
import { expectAudio, expectMediaFlowing, setupCall } from "../lib/call.ts";
import { expect, test } from "../lib/fixtures.ts";
import { qaInject, qaLogs, qaState, qaStats, qaTimeline, TID, tid } from "../lib/qa.ts";

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
      // 3–4 tier: every pair exposes its adaptive send level and the cap it applied (ADR-0008).
      for (const p of ps) {
        await expect
          .poll(async () => (await qaStats(p.page)).map((s) => s.video.sendLevel ?? "missing").sort(), {
            timeout: 10_000,
            message: `${p.name} send levels`,
          })
          .toEqual(expect.arrayContaining(Array(n - 1).fill(expect.stringMatching(/^(base|high)$/))));
        for (const s of await qaStats(p.page)) {
          expect([400_000, 600_000, 800_000], `${p.name} cap`).toContain(s.video.sendMaxBitrate);
          // Firefox has no uplink estimate → by design it never leaves base (and so never changes the
          // degradation preference or the cap of a possibly-H264 sender mid-call).
          if (browserName === "firefox") {
            expect(s.availableOutgoingBitrate, `${p.name} estimate`).toBeUndefined();
            expect(s.video.sendLevel).toBe("base");
          }
        }
      }
      for (const p of call.all) expect(p.diag.pageErrors, `${p.name} page errors`).toEqual([]);
    });
  }

  test("3-party send level (ADR-0008): upgrades to 800 kbps on a good link, drops back fast when squeezed", async ({
    call,
    browserName,
  }) => {
    // Firefox exposes no availableOutgoingBitrate (stays at base by design); WebKit shares one capture per browser.
    test.skip(browserName !== "chromium", "upgrade needs Chromium's uplink estimate");
    test.setTimeout(150_000);
    // Phone-sized tiles so receivers ask for the full 360p rung (the level only matters there).
    const contextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 };
    const ps = [];
    for (const name of ["Alice", "Bob", "Carol"]) ps.push(await call.participant(name, { contextOptions }));
    // Squeeze tool (no netem on macOS): when window.__bwCapKbps is set, Alice applies remote descriptions with
    // `b=AS:<kbps>` on the video section. libwebrtc feeds that into its transport controller's max bitrate, which
    // clamps the real GCC estimate (availableOutgoingBitrate) — a congestion-controller-level squeeze without
    // queueing or loss. Remote descriptions are applied again by any renegotiation (here an ICE restart).
    await ps[0]!.page.addInitScript(() => {
      const srd = RTCPeerConnection.prototype.setRemoteDescription;
      RTCPeerConnection.prototype.setRemoteDescription = function (
        this: RTCPeerConnection,
        d?: RTCSessionDescriptionInit,
      ) {
        const cap = (window as unknown as { __bwCapKbps?: number }).__bwCapKbps;
        if (cap && d?.sdp)
          d = {
            type: d.type,
            sdp: d.sdp.replace(/(m=video[^\r\n]*\r\n(?:[icb]=[^\r\n]*\r\n)*)/, `$1b=AS:${cap}\r\n`),
          };
        return (srd as (d?: RTCSessionDescriptionInit) => Promise<void>).call(this, d);
      } as typeof srd;
    });
    await setupCall(ps, 30_000);
    await Promise.all(ps.map((p) => expectMediaFlowing(p.page, { timeout: 20_000, label: p.name })));
    // Upgrade needs 10 s of headroom (+5 s stagger per extra pair): at least one pair per sender within 40 s.
    for (const p of ps) {
      await expect
        .poll(async () => (await qaStats(p.page)).filter((s) => s.video.sendLevel === "high").length, {
          timeout: 40_000,
          intervals: [1000],
          message: `${p.name}: a pair at the high level`,
        })
        .toBeGreaterThanOrEqual(1);
    }
    const alice = await qaStats(ps[0]!.page);
    const high = alice.find((s) => s.video.sendLevel === "high")!;
    expect(high.video.sendMaxBitrate).toBe(800_000);
    // The level change is logged with its reason for diag/telemetry.
    const logs = await qaLogs(ps[0]!.page);
    expect(logs.some((l) => l.msg === "send level" && l.data?.level === "high")).toBe(true);

    // Squeeze Alice's uplink estimate to 400 kbps per pair (< 800 + audio): every pair must be back at base fast.
    const alicePage = ps[0]!.page;
    await alicePage.evaluate(() => {
      (window as unknown as { __bwCapKbps?: number }).__bwCapKbps = 400;
    });
    const t0 = Date.now();
    await qaInject(alicePage, "restart-ice");
    // Renegotiation time (inject → clamped estimate) depends on host load; it is not the controller's.
    await expect
      .poll(async () => (await qaStats(alicePage)).map((s) => s.video.sendLevel), {
        timeout: 25_000,
        intervals: [250],
        message: "Alice: every pair back at base after the squeeze",
      })
      .toEqual(["base", "base"]);
    const downs = (await qaLogs(alicePage)).filter((l) => l.msg === "send level" && l.data?.level === "base");
    // The controller's part, from Alice's 1 Hz timeline: first sample with every estimate clamped → all at base.
    const tl = (await qaTimeline(alicePage)).filter((s) => s.t >= t0 - 3000);
    for (const s of tl)
      console.log(
        `  t=${s.t - t0} ${s.peers.map((p) => `${Math.round((p.availableOutgoingBitrate ?? 0) / 1000)}k/${p.video.sendLevel}`).join("  ")}`,
      );
    const clamped = tl.find(
      (s) => s.t >= t0 && s.peers.every((p) => (p.availableOutgoingBitrate ?? 1e9) <= 450_000),
    );
    const atBase = tl.find((s) => s.t >= t0 && s.peers.every((p) => p.video.sendLevel === "base"));
    expect(clamped, "estimate clamped by the squeeze").toBeDefined();
    expect(atBase).toBeDefined();
    const reactMs = atBase!.t - clamped!.t;
    console.log(
      `squeeze: renegotiated in ${clamped!.t - t0} ms, base ${reactMs} ms after the estimate drop; reasons ${downs.map((l) => l.data?.reason).join(",")}`,
    );
    // 3 s downgrade hold (3 samples) + sampler phase; a pair upgraded within the grace period counts too
    expect(reactMs).toBeLessThanOrEqual(5_000);
    expect(
      downs.every((l) => ["estimate-drop", "bandwidth-limited", "loss"].includes(String(l.data?.reason))),
    ).toBe(true);
    for (const s of await qaStats(alicePage)) {
      expect(s.video.sendMaxBitrate).toBe(600_000);
      expect(s.availableOutgoingBitrate ?? 0).toBeLessThanOrEqual(450_000);
    }
    for (const p of call.all) expect(p.diag.pageErrors, `${p.name} page errors`).toEqual([]);
  });
});
