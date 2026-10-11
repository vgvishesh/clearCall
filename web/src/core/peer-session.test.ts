import type { SignalPayload } from "@clearcall/protocol";
import { describe, expect, it } from "vitest";
import type { CodecPrefs } from "./codecs.ts";
import { type LocalTracks, type PeerRole, PeerSession } from "./peer-session.ts";
import { mungeVideoFmtp, readOpusFmtp } from "./sdp.ts";
import { SerialQueue } from "./serial-queue.ts";
import { advanceAndSettle, FakeClock, settle } from "./testing/fake-clock.ts";
import { asFake, createFakeRtc, FakeMediaStream, FakeTrack } from "./testing/fake-webrtc.ts";
import { testLog } from "./testing/test-log.ts";
import type { AudioMode, PeerConnectionStatus } from "./types.ts";

const LOW = "AAAAAAAAAAAAAAAA"; // polite (smaller)
const HIGH = "zzzzzzzzzzzzzzzz"; // impolite

interface Side {
  s: PeerSession;
  local: LocalTracks;
  sent: SignalPayload[];
  statuses: PeerConnectionStatus[];
  messages: unknown[];
  streams: MediaStream[];
  ctlOpened: number;
  /** `stalled` events (lost offer/answer → the owner rebuilds the pair). */
  stalls: string[];
  signalingUp: boolean;
  /** Drop outbound signals while true. */
  mute: boolean;
}

function mkLocal(mode: AudioMode = "voice"): LocalTracks {
  const audio = new FakeTrack("audio");
  const video = new FakeTrack("video");
  return {
    audio: audio as unknown as MediaStreamTrack,
    video: video as unknown as MediaStreamTrack,
    stream: new FakeMediaStream([audio, video]) as unknown as MediaStream,
    mode,
    sourceShortSide: 720,
  };
}

function setup(
  opts: {
    aId?: string;
    bId?: string;
    aRole?: PeerRole;
    bRole?: PeerRole;
    codecPrefs?: CodecPrefs;
    caps?: boolean;
  } = {},
) {
  const rtc = createFakeRtc();
  const clock = new FakeClock();
  let iceServers: RTCIceServer[] = [{ urls: "stun:one" }];
  const sides: Record<"a" | "b", Side> = {} as Record<"a" | "b", Side>;
  const queues = { a: new SerialQueue(), b: new SerialQueue() };
  const mk = (me: "a" | "b", selfId: string, remoteId: string, role: PeerRole) => {
    const other = me === "a" ? "b" : "a";
    const side = {
      sent: [],
      statuses: [],
      messages: [],
      streams: [],
      ctlOpened: 0,
      stalls: [],
      local: mkLocal(),
      signalingUp: true,
      mute: false,
    } as unknown as Side;
    side.s = new PeerSession({
      selfId,
      remoteId,
      role,
      RTCPeerConnection: rtc.RTCPeerConnection,
      MediaStream: rtc.MediaStream,
      clock,
      log: testLog.scope(me),
      iceServers: () => iceServers,
      local: () => side.local,
      isSignalingUp: () => side.signalingUp,
      ...(opts.codecPrefs ? { codecPrefs: opts.codecPrefs } : {}),
      ...(opts.caps
        ? {
            getCapabilities: (kind: "audio" | "video") => ({
              codecs:
                kind === "audio"
                  ? [
                      { mimeType: "audio/red", clockRate: 48000 },
                      { mimeType: "audio/opus", clockRate: 48000 },
                    ]
                  : [
                      { mimeType: "video/VP8", clockRate: 90000 },
                      { mimeType: "video/H264", clockRate: 90000 },
                    ],
            }),
          }
        : {}),
      sendSignal: (p) => {
        side.sent.push(p);
        if (side.mute) return;
        const copy = JSON.parse(JSON.stringify(p)) as SignalPayload;
        queueMicrotask(() => queues[other].push(() => sides[other].s.handleSignal(copy)));
      },
      events: {
        status: (st) => side.statuses.push(st),
        message: (m) => side.messages.push(m),
        stream: (st) => side.streams.push(st),
        ctlOpen: () => side.ctlOpened++,
        stalled: (r: string) => side.stalls.push(r),
      },
    });
    sides[me] = side;
  };
  const aId = opts.aId ?? HIGH;
  const bId = opts.bId ?? LOW;
  mk("a", aId, bId, opts.aRole ?? "offerer");
  mk("b", bId, aId, opts.bRole ?? "answerer");
  return {
    rtc,
    clock,
    a: sides.a,
    b: sides.b,
    setIceServers: (s: RTCIceServer[]) => {
      iceServers = s;
    },
  };
}

const pcOf = (side: Side) => asFake(side.s.pc);
const offersSent = (side: Side) =>
  side.sent.filter((p) => p.k === "sdp" && p.description.type === "offer").length;

function expectThreeMLines(side: Side) {
  const pc = pcOf(side);
  expect(pc.mlineCount).toBe(3);
  expect(pc.getTransceivers()).toHaveLength(2);
  expect(pc.getTransceivers().map((t) => t.kind)).toEqual(["audio", "video"]);
  expect(pc.signalingState).toBe("stable");
}

describe("PeerSession — newcomer offers, answerer reuses transceivers", () => {
  it("connects with exactly 3 m-lines, ctl open both ways, tracks attached", async () => {
    const { a, b } = setup();
    await settle();
    expect(a.s.status).toBe("connected");
    expect(b.s.status).toBe("connected");
    expectThreeMLines(a);
    expectThreeMLines(b);
    expect(pcOf(a).addTransceiverCalls).toBe(2);
    expect(pcOf(b).addTransceiverCalls).toBe(0);
    // answerer sends our local tracks on the offer's transceivers
    const bt = pcOf(b).getTransceivers();
    expect(bt.map((t) => t.direction)).toEqual(["sendrecv", "sendrecv"]);
    expect(bt[0]!.sender.track).toBe(b.local.audio);
    expect(bt[1]!.sender.track).toBe(b.local.video);
    // ctl
    expect(a.ctlOpened).toBe(1);
    expect(b.ctlOpened).toBe(1);
    expect(a.s.sendCtl({ k: "view", height: 360 })).toBe(true);
    expect(b.s.sendCtl({ k: "bye" })).toBe(true);
    await settle();
    expect(b.messages).toEqual([{ k: "view", height: 360 }]);
    expect(a.messages).toEqual([{ k: "bye" }]);
    // a remote stream with both receiver tracks
    expect(a.streams.at(-1)!.getTracks()).toHaveLength(2);
    expect(b.streams.at(-1)!.getTracks()).toHaveLength(2);
    // one offer, one answer
    expect(
      a.sent
        .filter((p) => p.k === "sdp")
        .map((p) => (p as { description: { type: string } }).description.type),
    ).toEqual(["offer"]);
    expect(b.sent.filter((p) => p.k === "sdp")).toHaveLength(1);
  });

  it("works with no local media at all (receive-only participant)", async () => {
    const { a, b } = setup();
    a.local = { audio: null, video: null, stream: null, mode: "voice" };
    await settle();
    expectThreeMLines(a);
    expectThreeMLines(b);
  });

  it("puts the tier's video start bitrate on local and remote descriptions", async () => {
    const { a, b } = setup();
    await settle();
    const start = (sdp: string) => /x-google-start-bitrate=(\d+)/.exec(sdp)?.[1];
    const aPc = pcOf(a);
    const bPc = pcOf(b);
    expect(start(aPc.sdpLog.find((x) => x.dir === "local")!.sdp)).toBe("1500"); // 2 participants
    expect(start(bPc.sdpLog.find((x) => x.dir === "remote")!.sdp)).toBe("1500");
    expect(start(bPc.sdpLog.find((x) => x.dir === "local")!.sdp)).toBe("1500");
    expect(mungeVideoFmtp(aPc.sdpLog[0]!.sdp, { "x-google-start-bitrate": 1500 })).toBe(aPc.sdpLog[0]!.sdp);
  });

  it("munges Opus fmtp on local and remote descriptions per our own mode", async () => {
    const { a, b } = setup();
    b.local.mode = "music";
    await settle();
    const aPc = pcOf(a);
    const bPc = pcOf(b);
    // a's local offer: voice → usedtx=1
    expect(readOpusFmtp(aPc.sdpLog.find((x) => x.dir === "local")!.sdp)).toMatchObject({
      usedtx: "1",
      useinbandfec: "1",
    });
    // b applied a's offer munged for b's mode (music → no DTX on b's encoder)
    expect(readOpusFmtp(bPc.sdpLog.find((x) => x.dir === "remote")!.sdp)).toMatchObject({ usedtx: "0" });
    expect(readOpusFmtp(bPc.sdpLog.find((x) => x.dir === "local")!.sdp)).toMatchObject({
      usedtx: "0",
      maxaveragebitrate: "128000",
    });
  });

  it("queues remote candidates until the remote description is set", async () => {
    const { a, b } = setup();
    await settle();
    // fresh pair, deliver ice before sdp manually
    const fresh = setup();
    fresh.a.mute = true;
    await settle();
    const offer = fresh.a.sent.find((p) => p.k === "sdp")!;
    const ice = fresh.a.sent.find((p) => p.k === "ice")!;
    await fresh.b.s.handleSignal(ice);
    expect(pcOf(fresh.b).addedCandidates).toHaveLength(0);
    await fresh.b.s.handleSignal(offer);
    expect(pcOf(fresh.b).addedCandidates).toHaveLength(1);
    expect(fresh.b.s.pristine).toBe(false);
    expect(a.s.pristine).toBe(false);
    expect(b.s.status).toBe("connected");
  });

  it("camera off/on and track swaps never renegotiate", async () => {
    const { a, b } = setup();
    await settle();
    const offers = () =>
      a.sent.filter((p) => p.k === "sdp").length + b.sent.filter((p) => p.k === "sdp").length;
    const before = offers();
    await a.s.setLocalTrack("video", null);
    await b.s.setLocalTrack("video", null);
    const t = new FakeTrack("video") as unknown as MediaStreamTrack;
    await a.s.setLocalTrack("video", t);
    await settle();
    expect(offers()).toBe(before);
    expect(pcOf(a).getTransceivers()[1]!.sender.track).toBe(t);
    expect(pcOf(b).getTransceivers()[1]!.sender.track).toBeNull();
  });
});

describe("PeerSession — glare", () => {
  it("renegotiation glare (both change mode at once) resolves with 3 m-lines", async () => {
    const { a, b } = setup();
    await settle();
    a.local.mode = "music";
    b.local.mode = "music";
    a.s.setMode("music");
    b.s.setMode("music");
    await settle(40);
    expectThreeMLines(a);
    expectThreeMLines(b);
    expect(a.s.status).toBe("connected");
    // Both encoders now see usedtx=0 in their applied remote descriptions.
    expect(readOpusFmtp(asFake(a.s.pc).remoteDescription!.sdp!)?.usedtx).toBe("0");
    expect(readOpusFmtp(asFake(b.s.pc).remoteDescription!.sdp!)?.usedtx).toBe("0");
  });

  it.each([
    ["a impolite", HIGH, LOW],
    ["a polite", LOW, HIGH],
  ])(
    "initial glare (both sides think they offer, %s) ends with one pc per side and 3 m-lines",
    async (_n, aId, bId) => {
      const { a, b, rtc } = setup({ aId, bId, aRole: "offerer", bRole: "offerer" });
      await settle(40);
      expect(a.s.status).toBe("connected");
      expect(b.s.status).toBe("connected");
      expectThreeMLines(a);
      expectThreeMLines(b);
      // The polite side rebuilt its pc as answerer.
      const polite = aId < bId ? a : b;
      expect(polite.s.role).toBe("answerer");
      expect(pcOf(polite).addTransceiverCalls).toBe(0);
      expect(rtc.pcs()).toHaveLength(3);
      expect(a.ctlOpened).toBe(1);
      expect(b.ctlOpened).toBe(1);
    },
  );

  it("initial glare where the impolite side hasn't offered yet: it becomes the answerer (3 m-lines)", async () => {
    const { a, b } = setup({ aId: HIGH, bId: LOW, aRole: "offerer", bRole: "offerer" });
    a.signalingUp = false; // a's negotiationneeded offer is deferred → a is stable when b's offer lands
    await settle(40);
    expect(a.s.role).toBe("answerer");
    expect(b.s.role).toBe("offerer");
    expect(a.s.status).toBe("connected");
    expectThreeMLines(a);
    expectThreeMLines(b);
  });
});

describe("PeerSession — ICE restart (FLOWS §6)", () => {
  it("impolite restarts immediately on failed, with fresh iceServers via setConfiguration", async () => {
    const { a, b, clock, setIceServers } = setup(); // a = HIGH = impolite
    await settle();
    setIceServers([{ urls: "turn:new", username: "u", credential: "c" }]);
    pcOf(a).breakLink("failed");
    expect(a.s.status).toBe("reconnecting");
    expect(b.s.status).toBe("reconnecting");
    clock.advance(0);
    await settle(30);
    expect(pcOf(a).restartIceCalls).toBe(1);
    expect(pcOf(a).setConfigurationCalls.at(-1)!.iceServers).toEqual([
      { urls: "turn:new", username: "u", credential: "c" },
    ]);
    expect(pcOf(b).restartIceCalls).toBe(0);
    expect(a.s.status).toBe("connected");
    expect(b.s.status).toBe("connected");
    expectThreeMLines(a);
    expectThreeMLines(b);
    // the polite side's deferred timer does nothing after recovery
    await advanceAndSettle(clock, 20_000, 1000);
    expect(pcOf(b).restartIceCalls).toBe(0);
  });

  it("disconnected: impolite waits 4 s before restarting", async () => {
    const { a, clock } = setup();
    await settle();
    pcOf(a).breakLink("disconnected");
    await advanceAndSettle(clock, 3900, 100);
    expect(pcOf(a).restartIceCalls).toBe(0);
    await advanceAndSettle(clock, 200, 100);
    expect(pcOf(a).restartIceCalls).toBe(1);
  });

  it("polite initiates only if nothing happened within a further 4 s", async () => {
    const { a, b, clock } = setup();
    await settle();
    a.signalingUp = false; // impolite can't restart
    pcOf(a).breakLink("failed");
    await advanceAndSettle(clock, 7_900, 100);
    expect(pcOf(b).restartIceCalls).toBe(0);
    await advanceAndSettle(clock, 200, 100);
    expect(pcOf(b).restartIceCalls).toBe(1);
    expect(b.s.status).toBe("connected");
  });

  it("restarts are deferred while signaling is down and run when it returns", async () => {
    const { a, clock } = setup();
    await settle();
    a.signalingUp = false;
    pcOf(a).breakLink("failed");
    await advanceAndSettle(clock, 1000, 100);
    expect(pcOf(a).restartIceCalls).toBe(0);
    a.signalingUp = true;
    a.s.onSignalingRestored();
    await settle(30);
    expect(pcOf(a).restartIceCalls).toBe(1);
    expect(a.s.status).toBe("connected");
  });

  it("gives up after 3 restarts with backoff → failed", async () => {
    const { a, rtc, clock } = setup();
    await settle();
    rtc.env.blocked = true;
    pcOf(a).breakLink("failed");
    await advanceAndSettle(clock, 60_000, 500);
    expect(pcOf(a).restartIceCalls).toBe(3);
    expect(a.s.status).toBe("failed");
  });

  it("a pair that never connects is treated as failed after the connect timeout", async () => {
    const { a, b, rtc, clock } = setup();
    rtc.env.blocked = true;
    await settle();
    expect(a.s.status).toBe("connecting");
    await advanceAndSettle(clock, 20_100, 500);
    expect(pcOf(a).restartIceCalls).toBeGreaterThanOrEqual(1);
    rtc.env.blocked = false;
    await advanceAndSettle(clock, 6_000, 500);
    expect(a.s.status).toBe("connected");
    expect(b.s.status).toBe("connected");
  });

  it("lost offer: at the connect timeout both sides report stalled instead of ICE-restarting", async () => {
    const { a, b, clock } = setup();
    a.mute = true; // the offer (and a's candidates) never reach b
    await settle(30);
    expect(pcOf(a).signalingState).toBe("have-local-offer");
    expect(pcOf(b).connectionState).toBe("new");
    await advanceAndSettle(clock, 20_100, 500);
    expect(a.stalls).toEqual(["no-answer"]);
    expect(b.stalls).toEqual(["no-offer"]);
    // A restart can't help when the offer was lost: never attempted, never "failed".
    await advanceAndSettle(clock, 40_000, 1000);
    expect(pcOf(a).restartIceCalls).toBe(0);
    expect(pcOf(b).restartIceCalls).toBe(0);
    expect(a.statuses).not.toContain("failed");
    expect(b.statuses).not.toContain("failed");
    expect(a.stalls).toEqual(["no-answer"]); // reported once per pc; the owner rebuilds
  });

  it("stall detection waits while signaling is down (the resume diff handles it)", async () => {
    const { a, clock } = setup();
    a.mute = true;
    await settle(30);
    a.signalingUp = false;
    await advanceAndSettle(clock, 25_000, 500);
    expect(a.stalls).toEqual([]);
    a.signalingUp = true;
    await advanceAndSettle(clock, 20_100, 500);
    expect(a.stalls).toEqual(["no-answer"]);
  });

  it("both descriptions but no connectivity still uses ICE restart, not a rebuild", async () => {
    const { a, b, rtc, clock } = setup();
    rtc.env.blocked = true;
    await settle(30);
    expect(pcOf(a).remoteDescription).not.toBeNull();
    await advanceAndSettle(clock, 20_100, 500);
    expect(a.stalls).toEqual([]);
    expect(b.stalls).toEqual([]);
    expect(pcOf(a).restartIceCalls).toBe(1);
  });

  it("a lost ICE-restart offer on a once-connected pair escalates to a rebuild, not 3 futile restarts", async () => {
    const { a, rtc, clock } = setup();
    await settle(30);
    expect(a.s.status).toBe("connected");
    a.mute = true;
    rtc.env.blocked = true;
    pcOf(a).breakLink("failed");
    await advanceAndSettle(clock, 6_000, 250);
    expect(pcOf(a).restartIceCalls).toBe(1);
    expect(pcOf(a).signalingState).toBe("have-local-offer");
    expect(a.stalls).toEqual(["no-answer"]);
    expect(a.statuses).not.toContain("failed");
  });

  it("an initial offer deferred while signaling was down is sent when it returns", async () => {
    const { a, b } = setup();
    a.signalingUp = false; // before negotiationneeded (a microtask) fires
    await settle(30);
    expect(pcOf(a).localDescription).toBeNull();
    a.signalingUp = true;
    a.s.onSignalingRestored();
    await settle(30);
    expect(a.s.status).toBe("connected");
    expect(b.s.status).toBe("connected");
    expectThreeMLines(a);
    expectThreeMLines(b);
  });

  it("peer hello re-sends an outstanding offer (with its candidates) only once it is old; duplicates are idempotent", async () => {
    const { a, b, clock } = setup();
    a.mute = true;
    await settle(30);
    const sentBefore = a.sent.length;
    a.mute = false;
    a.s.onPeerHello(); // ordinary join-time hello right after our offer → nothing
    expect(a.sent.length).toBe(sentBefore);
    clock.advance(3_000);
    a.s.onPeerHello();
    await settle(30);
    const resent = a.sent.slice(sentBefore);
    expect(resent[0]).toMatchObject({ k: "sdp", description: { type: "offer" } });
    expect(resent.some((p) => p.k === "ice")).toBe(true);
    expect(a.s.status).toBe("connected");
    expect(b.s.status).toBe("connected");
    // Same offer once more: b re-sends its answer, a (stable) ignores it — nothing breaks, still 3 m-lines.
    const answers = () => b.sent.filter((p) => p.k === "sdp").length;
    const n = answers();
    await b.s.handleSignal(resent[0]!);
    await settle(30);
    expect(answers()).toBe(n + 1);
    expectThreeMLines(a);
    expectThreeMLines(b);
    expect(a.s.status).toBe("connected");
  });

  it("an offer from a replaced remote pc on a used answerer pair rebuilds it (3 m-lines)", async () => {
    const { a, b } = setup();
    await settle(30);
    expect(b.s.status).toBe("connected");
    const oldB = pcOf(b);
    // a's pc is replaced by a brand-new offerer pc (its hello never arrived).
    a.s.close();
    const PC = b.s.pc.constructor as typeof RTCPeerConnection;
    const fresh = new PC();
    fresh.addTransceiver("audio", { direction: "sendrecv" });
    fresh.addTransceiver("video", { direction: "sendrecv" });
    fresh.createDataChannel("ctl", { negotiated: true, id: 0 });
    await fresh.setLocalDescription();
    await b.s.handleSignal({ k: "sdp", description: { type: "offer", sdp: fresh.localDescription!.sdp } });
    await settle(10);
    expect(pcOf(b)).not.toBe(oldB);
    expect(oldB.signalingState).toBe("closed");
    expectThreeMLines(b);
  });

  it("manual restart works and kill marks the pair failed", async () => {
    const { a } = setup();
    await settle();
    a.s.restartIce("manual");
    await settle(30);
    expect(pcOf(a).restartIceCalls).toBe(1);
    expect(a.s.status).toBe("connected");
    a.s.kill();
    expect(a.s.status).toBe("failed");
    expect(a.s.isClosed).toBe(true);
  });
});

describe("PeerSession — encode policy", () => {
  it("applies ADR-0005 caps, receiver view and audio mode via setParameters", async () => {
    const { a } = setup();
    await settle(30);
    const [at, vt] = pcOf(a).getTransceivers();
    expect(vt!.sender.params.encodings[0]).toMatchObject({
      maxBitrate: 1_500_000,
      maxFramerate: 30,
      active: true,
    });
    expect(at!.sender.params.encodings[0]).toMatchObject({ maxBitrate: 32_000 });
    a.s.setParticipants(4);
    await a.s.applyEncodings();
    expect(vt!.sender.params.encodings[0]).toMatchObject({ maxBitrate: 600_000, scaleResolutionDownBy: 2 });
    a.s.setRemoteView(0);
    await a.s.applyEncodings();
    expect(vt!.sender.params.encodings[0]!.active).toBe(false);
    a.s.setRemoteView(150);
    a.s.setParticipants(6);
    await a.s.applyEncodings();
    expect(vt!.sender.params.encodings[0]).toMatchObject({
      active: true,
      maxBitrate: 150_000,
      maxFramerate: 15,
    });
    a.local.mode = "music";
    a.s.setMode("music");
    await settle(30);
    expect(at!.sender.params.encodings[0]).toMatchObject({ maxBitrate: 96_000 });
    // unchanged policy → no redundant setParameters
    const calls = vt!.sender.setParametersCalls.length;
    await a.s.applyEncodings();
    expect(vt!.sender.setParametersCalls.length).toBe(calls);
  });

  it("applies codec preferences on both sides (offerer at creation, answerer after SRD)", async () => {
    const { a, b } = setup({ codecPrefs: { red: false, videoOrder: ["video/H264"] }, caps: true });
    await settle();
    for (const side of [a, b]) {
      const [at, vt] = pcOf(side).getTransceivers();
      expect((at!.codecPreferences as { mimeType: string }[]).map((c) => c.mimeType)).toEqual(["audio/opus"]);
      expect((vt!.codecPreferences as { mimeType: string }[])[0]!.mimeType).toBe("video/H264");
    }
    const none = setup({ codecPrefs: { red: false, videoOrder: null } });
    await settle();
    expect(pcOf(none.a).getTransceivers()[0]!.codecPreferences).toBeNull();
  });

  it("crossing a codec tier renegotiates (new order applies); within a tier it doesn't", async () => {
    const { a, b } = setup({ codecPrefs: { red: false, videoOrder: null }, caps: true });
    await settle();
    const sdps = () =>
      a.sent.filter((p) => p.k === "sdp").length + b.sent.filter((p) => p.k === "sdp").length;
    const n0 = sdps();
    a.s.setParticipants(4); // tier 2 → 4 (same tier as 3)
    b.s.setParticipants(4);
    await settle();
    const n1 = sdps();
    expect(n1).toBe(n0 + 2); // one offer (impolite side only) + its answer, no glare
    a.s.setParticipants(3); // still tier 4
    b.s.setParticipants(3);
    await settle();
    expect(sdps()).toBe(n1);
    expect(pcOf(a).signalingState).toBe("stable");
    expect(pcOf(b).signalingState).toBe("stable");
    expectThreeMLines(a);
    expectThreeMLines(b);
  });

  /**
   * A third peer joins → both sides of an existing pair cross the codec tier at the same moment. Before: both
   * re-offered, so every join glared and the polite side's offer was rolled back (one wasted offer, a rollback right
   * after the policy's setParameters). Now only the impolite side offers; the polite side's order goes into its answer.
   */
  it("both sides crossing a tier at once: one offer, no rolled-back local offer, new order + caps on both", async () => {
    const { a, b, clock } = setup({
      codecPrefs: { red: false, videoOrder: ["video/H264"] },
      caps: true,
    });
    await settle();
    const [a0, b0] = [offersSent(a), offersSent(b)];
    const bVideo = pcOf(b).getTransceivers()[1]!;
    const bPrefsBefore = bVideo.codecPreferences;
    // Like the mesh on `peer-joined`: both sides learn the third peer at once (polite b first, the worst order).
    b.s.setParticipants(3);
    a.s.setParticipants(3);
    await settle(40);
    expect(offersSent(a) - a0).toBe(1); // impolite side re-offers
    expect(offersSent(b) - b0).toBe(0); // polite side only answers
    for (const side of [a, b]) {
      expect(pcOf(side).localOfferRollbacks).toBe(0);
      expectThreeMLines(side);
      expect(side.s.status).toBe("connected");
    }
    // The polite side's new tier order still applies — to its answer.
    expect(bVideo.codecPreferences).not.toBe(bPrefsBefore);
    expect(bVideo.sender.params.encodings[0]).toMatchObject({ scaleResolutionDownBy: 2 });
    // No stray fallback offer later either.
    await advanceAndSettle(clock, 10_000, 1000);
    expect(offersSent(b) - b0).toBe(0);
  });

  it("polite side re-offers for a tier change only if the impolite side doesn't within politeExtraMs", async () => {
    const { a, b, clock } = setup({ codecPrefs: { red: false, videoOrder: null }, caps: true });
    await settle();
    const b0 = offersSent(b);
    b.s.setParticipants(3); // only the polite side sees the third peer (e.g. a still hides it)
    await advanceAndSettle(clock, 3900, 100);
    expect(offersSent(b)).toBe(b0);
    await advanceAndSettle(clock, 200, 100);
    expect(offersSent(b)).toBe(b0 + 1);
    expect(pcOf(a).signalingState).toBe("stable");
    expect(pcOf(b).signalingState).toBe("stable");
    expectThreeMLines(a);
    expectThreeMLines(b);
  });

  it("a polite tier fallback is dropped once the impolite side's offer arrives", async () => {
    const { a, b, clock } = setup({ codecPrefs: { red: false, videoOrder: null }, caps: true });
    await settle();
    const b0 = offersSent(b);
    b.s.setParticipants(3);
    await advanceAndSettle(clock, 2000, 100);
    a.s.setParticipants(3); // impolite side catches up within the window
    await advanceAndSettle(clock, 10_000, 500);
    expect(offersSent(b)).toBe(b0);
    expect(pcOf(b).localOfferRollbacks).toBe(0);
  });
});

describe("PeerSession — getStats always settles (Firefox drops a getStats pending at pc close)", () => {
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message}`,
    );

  it("a getStats pending when the session closes rejects instead of hanging", async () => {
    const { a } = setup();
    await settle();
    const pending = outcome(a.s.getStats());
    a.s.close(); // the fake, like Firefox, never settles the pc's own promise now
    await settle();
    expect(await pending).toBe("rejected: peer session closed");
  });

  it("an injected kill (pc closed first) also settles a pending getStats", async () => {
    const { a } = setup();
    await settle();
    const pending = outcome(a.s.getStats());
    a.s.kill();
    await settle();
    expect(await pending).toBe("rejected: peer session closed");
  });

  it("getStats on a closed session rejects at once; on an open one it resolves", async () => {
    const { a, b } = setup();
    await settle();
    expect(await outcome(b.s.getStats())).toBe("resolved");
    a.s.close();
    expect(await outcome(a.s.getStats())).toBe("rejected: peer session closed");
  });
});
