import { deriveRoomKeys, generatePeerId, generateSecret } from "@clearcall/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import type { LocalTracks } from "../peer-session.ts";
import { readOpusFmtp } from "../sdp.ts";
import { roomCipher, type SignalCipher, SignalingClient } from "../signaling-client.ts";
import { advanceAndSettle, FakeClock, settle } from "../testing/fake-clock.ts";
import { FakeSignalingServer } from "../testing/fake-signaling.ts";
import { asFake, createFakeRtc, FakeMediaStream, FakeTrack } from "../testing/fake-webrtc.ts";
import { testLog } from "../testing/test-log.ts";
import { MeshTransport, PROBE_MS } from "./mesh.ts";
import type { LocalAnnounce } from "./types.ts";

let cipher: SignalCipher;
beforeAll(async () => {
  cipher = roomCipher(await deriveRoomKeys(generateSecret()));
});

function world() {
  const clock = new FakeClock();
  return { clock, server: new FakeSignalingServer(clock), rtc: createFakeRtc() };
}
type World = ReturnType<typeof world>;

interface P {
  id: string;
  mesh: MeshTransport;
  client: SignalingClient;
  local: LocalTracks;
  announce: LocalAnnounce;
  welcomes: number;
}

function addPeer(w: World, name: string, id = generatePeerId()): P {
  const audio = new FakeTrack("audio");
  const video = new FakeTrack("video");
  const p = {
    id,
    welcomes: 0,
    announce: { name, mic: true, cam: true, mode: "voice" },
    local: {
      audio: audio as unknown as MediaStreamTrack,
      video: video as unknown as MediaStreamTrack,
      stream: new FakeMediaStream([audio, video]) as unknown as MediaStream,
      mode: "voice",
      sourceShortSide: 720,
    },
  } as P;
  const log = testLog.scope(`mesh:${name}`);
  p.mesh = new MeshTransport({
    selfId: id,
    RTCPeerConnection: w.rtc.RTCPeerConnection,
    MediaStream: w.rtc.MediaStream,
    clock: w.clock,
    sendSignal: (to, payload) => p.client.send(to, payload),
    local: () => p.local,
    announce: () => p.announce,
    log,
  });
  p.client = new SignalingClient({
    url: "ws://t/api/room/r",
    peerId: id,
    cipher,
    WebSocket: w.server.WebSocket,
    clock: w.clock,
    random: () => 0.5,
    log: testLog.scope(`sig:${name}`),
    handlers: {
      welcome: (info) => p.mesh.welcome(info, p.welcomes++ === 0),
      peerJoined: (x) => p.mesh.peerJoined(x),
      peerLeft: (x, r) => p.mesh.peerLeft(x, r),
      signal: (from, payload) => p.mesh.signal(from, payload),
      error: (code, peerId) => p.mesh.signalingError(code, peerId),
      status: (s) => p.mesh.signalingUp(s === "open"),
    },
  });
  p.client.connect();
  return p;
}

const sessionsOf = (p: P) =>
  p.mesh.participants().map((r) => ({
    id: r.id,
    s: (p.mesh as unknown as { roster: Map<string, { session: { pc: unknown } | null }> }).roster.get(r.id)!
      .session,
  }));

function pcFor(p: P, remote: string) {
  const roster = (p.mesh as unknown as { roster: Map<string, { session: { pc: unknown } | null }> }).roster;
  return asFake(roster.get(remote)!.session!.pc);
}

const rosterIds = (p: P) => [...(p.mesh as unknown as { roster: Map<string, unknown> }).roster.keys()];

function expectFullMesh(peers: P[]) {
  for (const p of peers) {
    const others = peers.filter((x) => x !== p);
    expect(
      p.mesh
        .participants()
        .map((r) => r.id)
        .sort(),
    ).toEqual(others.map((x) => x.id).sort());
    for (const r of p.mesh.participants()) {
      expect(r.status, `${p.announce.name}→${r.id}`).toBe("connected");
      const pc = pcFor(p, r.id);
      expect(pc.mlineCount).toBe(3);
      expect(pc.getTransceivers()).toHaveLength(2);
      expect(r.name).toBe(peers.find((x) => x.id === r.id)!.announce.name);
    }
  }
}

describe("MeshTransport", () => {
  it("3 participants join one after another: full mesh, newcomer offers, names via hello/state", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const b = addPeer(w, "Bob");
    await settle(60);
    const c = addPeer(w, "Cid");
    await settle(80);
    expectFullMesh([a, b, c]);
    // c learned a and b from welcome → c offered (added transceivers); a/b answered c
    expect(pcFor(c, a.id).addTransceiverCalls).toBe(2);
    expect(pcFor(a, c.id).addTransceiverCalls).toBe(0);
    expect(pcFor(b, c.id).addTransceiverCalls).toBe(0);
    expect(a.mesh.participants().map((r) => r.id)).toEqual([b.id, c.id]); // join order
    expect(a.mesh.participants()[0]!.stream).not.toBeNull();
  });

  it("applies the participant-count policy to every connection (4 people → 360p/600 kbps)", async () => {
    const w = world();
    const ps: P[] = [];
    for (const n of ["A", "B", "C", "D"]) {
      ps.push(addPeer(w, n));
      await settle(60);
    }
    await settle(60);
    expectFullMesh(ps);
    for (const p of ps)
      for (const r of p.mesh.participants()) {
        const enc = pcFor(p, r.id).getTransceivers()[1]!.sender.params.encodings[0]!;
        expect(enc).toMatchObject({ maxBitrate: 600_000, scaleResolutionDownBy: 2 });
      }
  });

  it("state changes reach peers over ctl; mode change renegotiates DTX off", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const b = addPeer(w, "Bob");
    await settle(60);
    a.announce = { ...a.announce, mic: false, cam: false };
    a.mesh.setLocalState(a.announce);
    await settle(20);
    expect(b.mesh.participants()[0]).toMatchObject({ micOn: false, camOn: false, name: "Ann" });
    a.local.mode = "music";
    a.announce = { ...a.announce, mode: "music" };
    a.mesh.setLocalState(a.announce);
    await settle(60);
    expect(b.mesh.participants()[0]!.mode).toBe("music");
    const aPc = pcFor(a, b.id);
    expect(readOpusFmtp(aPc.remoteDescription!.sdp!)?.usedtx).toBe("0");
    expect(aPc.getTransceivers()[0]!.sender.params.encodings[0]!.maxBitrate).toBe(96_000);
    expectFullMesh([a, b]);
  });

  it("view reports cap the sender; our hidden tab pauses everyone's video to us", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const b = addPeer(w, "Bob");
    await settle(60);
    a.mesh.reportView(b.id, 300);
    await settle(20);
    const bToA = () => pcFor(b, a.id).getTransceivers()[1]!.sender.params.encodings[0]!;
    expect(bToA()).toMatchObject({ maxBitrate: 600_000, active: true });
    a.mesh.reportView(b.id, 310); // same rung → no new message
    const sent = (pcFor(a, b.id).channels[0]!.sent as string[]).filter((x) => x.includes('"view"')).length;
    a.mesh.setHidden(true);
    await settle(20);
    expect(bToA().active).toBe(false);
    a.mesh.setHidden(false);
    await settle(20);
    expect(bToA().active).toBe(true);
    expect((pcFor(a, b.id).channels[0]!.sent as string[]).filter((x) => x.includes('"view"')).length).toBe(
      sent + 2,
    );
  });

  it("leave: bye + peer-left remove the participant everywhere", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const b = addPeer(w, "Bob");
    await settle(60);
    b.mesh.close({ bye: true });
    b.client.leave();
    await settle(30);
    expect(a.mesh.participants()).toEqual([]);
  });

  it("signaling drop + resume within grace keeps connected pairs untouched", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const b = addPeer(w, "Bob");
    await settle(60);
    const pcsBefore = w.rtc.pcs().length;
    w.server.dropPeer(a.id);
    await settle(10);
    expect(a.mesh.participants()[0]!.status).toBe("connected"); // media keeps flowing
    await advanceAndSettle(w.clock, 1000, 100);
    expect(a.client.status).toBe("open");
    expect(w.rtc.pcs().length).toBe(pcsBefore);
    expectFullMesh([a, b]);
  });

  it("resume diff: removes peers that left meanwhile and re-pairs unconnected ones", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const b = addPeer(w, "Bob");
    await settle(60);
    const c = addPeer(w, "Cid");
    await settle(80);
    w.server.refuse = true;
    w.server.dropPeer(a.id);
    await settle(10);
    // c leaves while a is away (a misses peer-left); the a↔b link dies meanwhile.
    c.mesh.close();
    c.client.leave();
    const oldPc = pcFor(a, b.id);
    oldPc.breakLink("failed");
    w.rtc.env.blocked = true;
    await advanceAndSettle(w.clock, 3000, 250);
    w.rtc.env.blocked = false;
    w.server.refuse = false;
    a.client.nudge();
    await advanceAndSettle(w.clock, 10_000, 250);
    expect(a.mesh.participants().map((r) => r.id)).toEqual([b.id]);
    expect(pcFor(a, b.id)).not.toBe(oldPc); // re-paired via hello, not just ICE-restarted
    expectFullMesh([a, b]);
  });

  it("grace expired → resumed:false → everything rebuilt from welcome", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const b = addPeer(w, "Bob");
    await settle(60);
    w.server.refuse = true;
    w.server.dropPeer(b.id); // b (newer) goes away for longer than the grace window
    await advanceAndSettle(w.clock, 21_000, 1000);
    expect(a.mesh.participants()).toEqual([]);
    w.server.refuse = false;
    b.client.nudge();
    await advanceAndSettle(w.clock, 10_000, 250);
    expect(b.client.status).toBe("open");
    expectFullMesh([a, b]);
  });

  it("hello resets a used pair (peer rebuilt its side via retry)", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const b = addPeer(w, "Bob");
    await settle(60);
    const oldA = pcFor(a, b.id);
    const oldB = pcFor(b, a.id);
    b.mesh.retry(a.id);
    await settle(80);
    expect(pcFor(a, b.id)).not.toBe(oldA);
    expect(pcFor(b, a.id)).not.toBe(oldB);
    expect(oldA.signalingState).toBe("closed");
    expectFullMesh([a, b]);
    // b learned a from welcome → b offered again
    expect(pcFor(b, a.id).addTransceiverCalls).toBe(2);
  });

  it("injected kill recovers automatically via the retry path", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const b = addPeer(w, "Bob");
    await settle(60);
    a.mesh.kill(b.id);
    await advanceAndSettle(w.clock, 100, 50);
    await settle(80);
    expectFullMesh([a, b]);
  });

  it("unknown-peer drops queued work and an unconnected pair until the peer's hello", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    w.rtc.env.blocked = true; // never connects
    const b = addPeer(w, "Bob");
    await settle(60);
    a.mesh.signalingError("unknown-peer", b.id);
    expect(sessionsOf(a)[0]!.s).toBeNull();
    w.rtc.env.blocked = false;
    b.mesh.retry(a.id);
    await settle(80);
    expectFullMesh([a, b]);
  });

  it("lost offer: the pair is rebuilt via hello at the connect timeout (newcomer re-offers), never ICE-restarted", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const bId = generatePeerId();
    w.server.relayFilter = (from) => from !== bId; // everything b sends to a is lost
    const b = addPeer(w, "Bob", bId);
    await settle(60);
    const stuckB = pcFor(b, a.id);
    const stuckA = pcFor(a, b.id);
    expect(stuckB.signalingState).toBe("have-local-offer");
    expect(stuckA.connectionState).toBe("new");
    w.server.relayFilter = null; // the network recovers; nobody re-sends on its own
    const statuses: string[] = [];
    for (const p of [a, b])
      p.mesh.onChange(() => statuses.push(...p.mesh.participants().map((r) => r.status)));
    await advanceAndSettle(w.clock, 21_000, 250);
    expectFullMesh([a, b]);
    expect(pcFor(b, a.id)).not.toBe(stuckB);
    expect(stuckB.signalingState).toBe("closed");
    expect(stuckB.restartIceCalls + stuckA.restartIceCalls).toBe(0);
    expect(statuses).not.toContain("failed");
    // roles per FLOWS §2: b learned a from welcome → b offers; a never adds transceivers
    expect(pcFor(b, a.id).addTransceiverCalls).toBe(2);
    expect(pcFor(a, b.id).addTransceiverCalls).toBe(0);
  });

  it("lost answer: offerer rebuilds, answerer's used pair is reset by the hello (3 m-lines)", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const bId = generatePeerId();
    w.server.relayFilter = (from) => from !== a.id; // a's answer + candidates are lost
    const b = addPeer(w, "Bob", bId);
    await settle(60);
    expect(pcFor(a, b.id).signalingState).toBe("stable"); // a answered
    expect(pcFor(b, a.id).signalingState).toBe("have-local-offer"); // b never got it
    w.server.relayFilter = null;
    await advanceAndSettle(w.clock, 21_000, 250);
    expectFullMesh([a, b]);
  });

  it("both sides resume at the same moment while an offer is in flight → fully connected (resume, not the stall timer)", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const bId = generatePeerId();
    w.server.relayFilter = (from) => from !== bId; // b's offer is in flight when the sockets die
    const b = addPeer(w, "Bob", bId);
    await settle(60);
    const stuckB = pcFor(b, a.id);
    expect(stuckB.signalingState).toBe("have-local-offer");
    w.server.dropPeer(a.id, 4006);
    w.server.dropPeer(b.id, 4006);
    w.server.relayFilter = null;
    await advanceAndSettle(w.clock, 5_000, 100); // well inside the 20 s connect timeout
    expect(a.client.status).toBe("open");
    expect(b.client.status).toBe("open");
    expectFullMesh([a, b]);
    expect(stuckB.signalingState).toBe("closed");
    // roles unchanged by the resume: b (learned a from its first welcome) offered, a answered
    expect(pcFor(b, a.id).addTransceiverCalls).toBe(2);
    expect(pcFor(a, b.id).addTransceiverCalls).toBe(0);
  });

  it("answerer alone resumes with a lost offer pending → its hello makes the offerer re-send (fast)", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const bId = generatePeerId();
    w.server.relayFilter = (from) => from !== bId;
    const b = addPeer(w, "Bob", bId);
    await settle(60);
    w.clock.advance(4_000); // the offer has been outstanding for a while
    w.server.dropPeer(a.id, 4006); // only a's socket dies
    w.server.relayFilter = null;
    await advanceAndSettle(w.clock, 5_000, 100);
    expectFullMesh([a, b]);
    expect(pcFor(a, b.id).addTransceiverCalls).toBe(0);
  });

  it("a peer first seen in a resumed welcome (joined while we were away) is answered, not glared", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    w.server.refuse = true;
    w.server.dropPeer(a.id, 4006);
    await settle(10);
    w.server.refuse = false;
    const c = addPeer(w, "Cid"); // learns a (away) from welcome.peers → offers → unknown-peer
    await settle(60);
    a.client.nudge();
    await advanceAndSettle(w.clock, 5_000, 100);
    expectFullMesh([a, c]);
    expect(pcFor(c, a.id).addTransceiverCalls).toBe(2);
    expect(pcFor(a, c.id).addTransceiverCalls).toBe(0);
  });

  it("reload without leave: the reloader hides the away ghost from welcome (unknown-peer) until peer-left", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const b = addPeer(w, "Bob");
    await settle(60);
    expectFullMesh([a, b]);
    // Firefox reload: pagehide's `leave` never reaches the server → old b is "away" for the grace window.
    b.mesh.close();
    b.client.close();
    await settle(10);
    const b2 = addPeer(w, "Bob");
    const seen = new Set<string>();
    b2.mesh.onChange(() => {
      for (const r of b2.mesh.participants()) seen.add(r.id);
    });
    await settle(80);
    expect(w.server.sentTo(b2.id, "welcome")[0]).toMatchObject({ peers: [a.id, b.id] });
    expect([...seen]).toEqual([a.id]); // never exposed, not even for a round trip
    expect(b2.mesh.resolving).toBe(false);
    // The ghost is hidden once the server said unknown-peer: one participant, connected, named …
    expect(b2.mesh.participants().map((r) => r.id)).toEqual([a.id]);
    expect(b2.mesh.participants()[0]).toMatchObject({ status: "connected", name: "Ann" });
    // … and it does not count toward the bandwidth policy (2 people → 720p tier, not the 3-person 360p one).
    expect(pcFor(b2, a.id).getTransceivers()[1]!.sender.params.encodings[0]!.maxBitrate).toBe(1_500_000);
    // Still in the roster (it may resume) until the server says it left.
    expect(rosterIds(b2)).toEqual([a.id, b.id]);
    // a learned old b via peer-joined and talked to it: it keeps the tile until the grace expires (FLOWS §5).
    expect(a.mesh.participants().map((r) => r.id)).toEqual([b.id, b2.id]);
    await advanceAndSettle(w.clock, 21_000, 1000);
    expect(rosterIds(b2)).toEqual([a.id]);
    expectFullMesh([a, b2]);
  });

  it("a hidden welcome peer becomes visible on its first signal (it resumed) and connects", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    w.server.refuse = true;
    w.server.dropPeer(a.id, 4006); // a is away (signaling only)
    await settle(10);
    w.server.refuse = false;
    const c = addPeer(w, "Cid");
    await settle(60);
    expect(c.mesh.participants()).toEqual([]); // a is listed in welcome but unknown to the server → hidden
    expect(rosterIds(c)).toEqual([a.id]);
    const seen: string[][] = [];
    c.mesh.onChange(() => seen.push(c.mesh.participants().map((r) => r.id)));
    a.client.nudge(); // a resumes → hello to c (FLOWS §4) → visible again
    await advanceAndSettle(w.clock, 5_000, 100);
    expect(seen[0]).toEqual([a.id]);
    expectFullMesh([a, c]);
  });

  it("unknown-peer does not hide a welcome peer we already heard from, nor one learned via peer-joined", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    const b = addPeer(w, "Bob");
    await settle(60);
    expectFullMesh([a, b]);
    // b learned a from welcome and heard from it; a learned b via peer-joined.
    w.rtc.env.blocked = true;
    pcFor(b, a.id).breakLink("failed");
    pcFor(a, b.id).breakLink("failed");
    await settle(10);
    b.mesh.signalingError("unknown-peer", a.id);
    a.mesh.signalingError("unknown-peer", b.id);
    expect(b.mesh.participants().map((r) => r.id)).toEqual([a.id]);
    expect(a.mesh.participants().map((r) => r.id)).toEqual([b.id]);
  });

  it("a live welcome peer whose signals are all lost is shown after the probe window", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    w.server.relayFilter = (from) => from !== a.id; // a's hello/answer never reach b
    const b = addPeer(w, "Bob");
    await settle(60);
    expect(b.mesh.participants()).toEqual([]);
    expect(b.mesh.resolving).toBe(true);
    await advanceAndSettle(w.clock, PROBE_MS, 100);
    expect(b.mesh.resolving).toBe(false);
    expect(b.mesh.participants().map((r) => r.id)).toEqual([a.id]);
    w.server.relayFilter = null;
    await advanceAndSettle(w.clock, 21_000, 250); // stalled negotiation recovers (FLOWS §2)
    expectFullMesh([a, b]);
  });

  it("ignores signals from peers not in the roster", async () => {
    const w = world();
    const a = addPeer(w, "Ann");
    await settle(30);
    a.mesh.signal(generatePeerId(), { k: "hello", name: "ghost" });
    await settle(5);
    expect(a.mesh.participants()).toEqual([]);
  });
});
