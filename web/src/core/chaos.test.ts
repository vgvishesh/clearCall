/**
 * Chaos: the signaling Worker declares every socket dead in one pass (close 4006) while the newest participant's
 * offers are in flight (regression for diag-20261011-200150: lost offers → 3 futile ICE restarts → "failed",
 * and "[signaling] giving up" while P2P media was still flowing).
 */
import { describe, expect, it } from "vitest";
import { advanceAndSettle, settle } from "./testing/fake-clock.ts";
import { asFake } from "./testing/fake-webrtc.ts";
import { createParticipant, createWorld, type Participant, type World } from "./testing/harness.ts";

async function join(w: World, link: string | null, name: string): Promise<Participant> {
  const p = createParticipant(w);
  await p.c.prepare(link ? { link } : {});
  await settle();
  await p.c.join(name);
  await settle(60);
  return p;
}

/** Records every participant status / phase ever seen, to catch transient "failed" or "ended". */
function watch(p: Participant) {
  const seen = { statuses: new Set<string>(), phases: new Set<string>() };
  p.c.state.subscribe((s) => {
    seen.phases.add(s.phase);
    for (const r of s.participants) seen.statuses.add(r.status);
  });
  return seen;
}

describe("chaos: every signaling socket dropped (4006) while the newest participant's offers are in flight", () => {
  // k = how many of the newcomer's signals the server relays before the mass drop: 5 hellos go first, so k=5
  // drops right as its first offer arrives, larger k catches offers/candidates later in flight.
  // overloadMs = how long the (still overloaded) server keeps losing the newcomer's signals after the drop — in
  // the diag the re-sent offers vanished too, leaving only the connect-timeout path.
  const cases = [5, 6, 8, 12].flatMap((k) => [0, 3_000].map((overloadMs) => ({ k, overloadMs })));
  for (const { k, overloadMs } of cases) {
    it(`6 participants, drop at the newcomer's signal #${k + 1}, its signals lost for ${overloadMs} ms more: all pairs connected within 30 s`, async () => {
      const w = createWorld();
      const first = await join(w, null, "P0");
      const link = first.c.state.value.link!;
      const ps = [first];
      for (let i = 1; i < 5; i++) ps.push(await join(w, link, `P${i}`));
      const old = new Set(ps.map((p) => p.c.peerId!));

      let relayed = 0;
      let droppedAt: number | null = null;
      w.server.relayFilter = (from) => {
        if (old.has(from)) return true;
        if (droppedAt !== null) return w.clock.now() - droppedAt >= overloadMs;
        if (relayed++ < k) return true;
        // The Worker's alarm pass: every socket declared dead at once, this signal (and those behind it) lost.
        droppedAt = w.clock.now();
        for (const id of w.server.activePeers()) w.server.dropPeer(id, 4006);
        return false;
      };
      const newest = await join(w, link, "P5");
      ps.push(newest);
      expect(droppedAt).not.toBeNull();

      const seen = ps.map(watch);
      await advanceAndSettle(w.clock, 30_000, 100);

      for (const [i, p] of ps.entries()) {
        const s = p.c.state.value;
        expect(s.phase, `P${i} phase`).toBe("in-call");
        expect(s.participants.map((r) => r.id).sort()).toEqual(
          ps
            .filter((x) => x !== p)
            .map((x) => x.c.peerId!)
            .sort(),
        );
        for (const r of s.participants) expect(r.status, `P${i}→${r.id.slice(0, 6)}`).toBe("connected");
        expect(seen[i]!.statuses.has("failed"), `P${i} saw a failed pair`).toBe(false);
        expect(seen[i]!.phases.has("ended"), `P${i} ended`).toBe(false);
        const logs = p.c.log.entries();
        expect(logs.some((e) => e.msg === "giving up")).toBe(false);
        expect(logs.some((e) => e.msg === "ice restarts exhausted")).toBe(false);
      }
      const live = w.rtc
        .pcs()
        .map(asFake)
        .filter((pc) => pc.signalingState !== "closed");
      expect(live).toHaveLength(30);
      for (const pc of live) {
        expect(pc.mlineCount).toBe(3);
        expect(pc.getTransceivers()).toHaveLength(2);
        expect(pc.connectionState).toBe("connected");
      }
    }, 30_000); // wall-clock budget: 6 controllers + real WebCrypto over 300 settle steps (fake time is the oracle)
  }
});
