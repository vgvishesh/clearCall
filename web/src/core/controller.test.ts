import { describe, expect, it, vi } from "vitest";
import { fatalToError } from "./controller.ts";
import { advanceAndSettle, settle } from "./testing/fake-clock.ts";
import { asFake, FakeDataChannel, type FakeTrack } from "./testing/fake-webrtc.ts";
import {
  createParticipant,
  createWorld,
  FakeAudioEl,
  type Participant,
  type World,
} from "./testing/harness.ts";
import type { QaHook } from "./types.ts";

const phase = (p: Participant) => p.c.state.value.phase;

async function startCall(w: World, name = "Ann") {
  const host = createParticipant(w);
  await host.c.prepare({});
  await settle();
  await host.c.join(name);
  await settle(30);
  return host;
}

async function joinCall(w: World, link: string, name: string) {
  const p = createParticipant(w);
  await p.c.prepare({ link });
  await settle();
  await p.c.join(name);
  await settle(60);
  return p;
}

function expectConnected(ps: Participant[]) {
  for (const p of ps) {
    const parts = p.c.state.value.participants;
    expect(parts.map((x) => x.id).sort()).toEqual(
      ps
        .filter((x) => x !== p)
        .map((x) => x.c.peerId!)
        .sort(),
    );
    for (const r of parts) expect(r.status).toBe("connected");
  }
}

describe("controller phases", () => {
  it("idle → lobby on prepare({}): new secret, canonical URL, media preview", async () => {
    const w = createWorld();
    const p = createParticipant(w);
    expect(phase(p)).toBe("idle");
    await p.c.prepare({});
    await settle();
    const s = p.c.state.value;
    expect(s.phase).toBe("lobby");
    expect(s.error).toBeNull();
    expect(s.link).toMatch(/^https:\/\/cc\.test\/c#[A-Za-z0-9_-]{43}$/);
    expect(p.replaceState).toEqual([`/c#${s.link!.split("#")[1]}`]);
    expect(s.local.stream!.getTracks()).toHaveLength(2);
    expect(s.local).toMatchObject({ micOn: true, camOn: true, camAvailable: true, micAvailable: true });
  });

  it("invalid link → error invalid-link; missing APIs → unsupported", async () => {
    const w = createWorld();
    const p = createParticipant(w);
    await p.c.prepare({ link: "https://cc.test/c#nope" });
    expect(p.c.state.value).toMatchObject({ phase: "error", error: { code: "invalid-link" } });
    const q = createParticipant(w, { RTCPeerConnection: undefined });
    await q.c.prepare({});
    expect(q.c.state.value.phase).toBe("error");
    expect(q.c.state.value.error).toMatchObject({ code: "unsupported", detail: "RTCPeerConnection" });
    const r = createParticipant(w, { isSecureContext: false });
    await r.c.prepare({});
    expect(r.c.state.value.error?.code).toBe("unsupported");
  });

  it("lobby device problems stay in the lobby with error set; joining still works (muted)", async () => {
    const w = createWorld();
    const host = await startCall(w);
    const p = createParticipant(w);
    p.devices.fail = { audio: "NotAllowedError", video: "NotAllowedError" };
    await p.c.prepare({ link: host.c.state.value.link! });
    await settle();
    expect(p.c.state.value).toMatchObject({
      phase: "lobby",
      error: { code: "permission-denied" },
      local: { micAvailable: false, camAvailable: false, micOn: false },
    });
    await p.c.join("Bob");
    await settle(60);
    expect(phase(p)).toBe("in-call");
    expect(p.c.state.value.error).toBeNull();
    expectConnected([host, p]);
    expect(host.c.state.value.participants[0]).toMatchObject({ name: "Bob", micOn: false, camOn: false });
  });

  it("joining → in-call; two people see and hear each other; remote audio via hidden elements", async () => {
    const w = createWorld();
    const a = await startCall(w, "Ann");
    expect(phase(a)).toBe("in-call");
    expect(a.c.state.value.joinedAt).toBe(w.clock.now());
    const b = await joinCall(w, a.c.state.value.link!, "Bob");
    expectConnected([a, b]);
    expect(a.c.state.value.participants[0]).toMatchObject({ name: "Bob", micOn: true, camOn: true });
    expect(b.c.state.value.participants[0]!.name).toBe("Ann");
    expect(a.c.state.value.participants[0]!.stream).not.toBeNull();
    // one hidden <audio> per remote participant, playing the remote stream
    expect(a.audioEls).toHaveLength(1);
    expect(a.audioEls[0]!.playing).toBe(true);
    expect(a.audioEls[0]!.srcObject).toBe(a.c.state.value.participants[0]!.stream);
    expect(a.c.state.value.audioBlocked).toBe(false);
  });

  it("mute/camera/name/mode changes reach the other side", async () => {
    const w = createWorld();
    const a = await startCall(w, "Ann");
    const b = await joinCall(w, a.c.state.value.link!, "Bob");
    a.c.setMic(false);
    await a.c.setCam(false);
    a.c.setName("Annie");
    await a.c.setMode("music");
    await settle(60);
    expect(b.c.state.value.participants[0]).toMatchObject({
      name: "Annie",
      micOn: false,
      camOn: false,
      mode: "music",
    });
    expect(a.c.state.value.local).toMatchObject({ micOn: false, camOn: false, mode: "music", name: "Annie" });
    expect(a.storage.get("clearcall.name")).toBe("Annie");
    expectConnected([a, b]);
  });

  it("setName trims and truncates to 40 chars and persists", async () => {
    const w = createWorld();
    const p = createParticipant(w);
    p.c.setName(`  ${"x".repeat(50)}  `);
    expect(p.c.state.value.local.name).toBe("x".repeat(40));
    expect(p.storage.get("clearcall.name")).toBe("x".repeat(40));
    const q = createParticipant(w, { storage: { getItem: () => "Stored", setItem: () => {} } });
    expect(q.c.state.value.local.name).toBe("Stored");
  });

  it("leave → ended with endedAt; the other side removes the participant; media stopped", async () => {
    const w = createWorld();
    const a = await startCall(w);
    const b = await joinCall(w, a.c.state.value.link!, "Bob");
    w.clock.advance(5000);
    b.c.leave();
    await settle(30);
    expect(b.c.state.value).toMatchObject({ phase: "ended", endedAt: w.clock.now(), error: null });
    expect(b.devices.live("audio")).toHaveLength(0);
    expect(b.devices.live("video")).toHaveLength(0);
    expect(a.c.state.value.participants).toEqual([]);
    expect(a.audioEls[0]!.removed).toBe(true);
  });

  it("controller is reusable: ended → prepare({link}) → join again as a new participant", async () => {
    const w = createWorld();
    const a = await startCall(w);
    const b = await joinCall(w, a.c.state.value.link!, "Bob");
    const firstId = b.c.peerId;
    b.c.leave();
    await settle(20);
    await b.c.prepare({ link: a.c.state.value.link! });
    await settle();
    expect(phase(b)).toBe("lobby");
    expect(b.c.state.value.endedAt).toBeNull();
    await b.c.join("Bob");
    await settle(60);
    expect(b.c.peerId).not.toBe(firstId);
    expectConnected([a, b]);
  });

  it("room full → error room-full (11th person)", async () => {
    const w = createWorld({ capacity: 2 });
    const a = await startCall(w);
    await joinCall(w, a.c.state.value.link!, "Bob");
    const c = await joinCall(w, a.c.state.value.link!, "Cid");
    expect(c.c.state.value).toMatchObject({ phase: "error", error: { code: "room-full" } });
    expect(c.devices.live("video")).toHaveLength(0);
  });

  it("server version mismatch → error version-mismatch", async () => {
    const w = createWorld({ version: 2 });
    const p = createParticipant(w);
    await p.c.prepare({});
    await settle();
    await p.c.join("Ann");
    await settle(30);
    expect(p.c.state.value.error?.code).toBe("version-mismatch");
    expect(phase(p)).toBe("error");
  });

  it("can't reach signaling while joining → error signaling-unavailable", async () => {
    const w = createWorld();
    w.server.refuse = true;
    const p = createParticipant(w);
    await p.c.prepare({});
    await settle();
    await p.c.join("Ann");
    await advanceAndSettle(w.clock, 21_000, 500);
    expect(p.c.state.value).toMatchObject({ phase: "error", error: { code: "signaling-unavailable" } });
  });

  it("signaling drop → reconnecting (media still connected) → in-call", async () => {
    const w = createWorld();
    const a = await startCall(w);
    const b = await joinCall(w, a.c.state.value.link!, "Bob");
    w.server.dropPeer(a.c.peerId!);
    await settle(10);
    expect(phase(a)).toBe("reconnecting");
    expect(a.c.state.value.participants[0]!.status).toBe("connected");
    await advanceAndSettle(w.clock, 1000, 100);
    expect(phase(a)).toBe("in-call");
    expectConnected([a, b]);
  });

  it("signaling gone for > 60 s after being in the call → ended with signaling-unavailable", async () => {
    const w = createWorld();
    const a = await startCall(w);
    w.server.refuse = true;
    w.server.dropPeer(a.c.peerId!);
    await advanceAndSettle(w.clock, 61_000, 1000);
    expect(a.c.state.value).toMatchObject({ phase: "ended", error: { code: "signaling-unavailable" } });
    expect(a.c.state.value.endedAt).not.toBeNull();
  });

  it("signaling down for minutes while P2P media flows → stays reconnecting (banner), never gives up", async () => {
    const w = createWorld();
    const a = await startCall(w);
    const b = await joinCall(w, a.c.state.value.link!, "Bob");
    w.server.refuse = true;
    for (const id of w.server.activePeers()) w.server.dropPeer(id, 4006);
    await advanceAndSettle(w.clock, 150_000, 1000);
    for (const p of [a, b]) {
      expect(phase(p)).toBe("reconnecting");
      expect(p.c.state.value.error).toBeNull();
      expect(p.c.state.value.participants[0]!.status).toBe("connected");
      expect(p.c.log.entries().some((e) => e.msg === "giving up")).toBe(false);
    }
    w.server.refuse = false;
    await advanceAndSettle(w.clock, 31_000, 500);
    expect(phase(a)).toBe("in-call");
    expect(phase(b)).toBe("in-call");
    expectConnected([a, b]);
  });

  it("signaling down and the last pair dies → ended 60 s after it stopped being connected", async () => {
    const w = createWorld();
    const a = await startCall(w);
    const b = await joinCall(w, a.c.state.value.link!, "Bob");
    w.server.refuse = true;
    w.server.dropPeer(a.c.peerId!, 4006);
    await advanceAndSettle(w.clock, 90_000, 1000);
    expect(phase(a)).toBe("reconnecting");
    // the P2P link dies too (no signaling → no ICE restart possible)
    w.rtc.env.blocked = true;
    const pc = w.rtc
      .pcs()
      .map(asFake)
      .find((x) => x.connectionState === "connected")!;
    pc.breakLink("failed");
    await advanceAndSettle(w.clock, 58_000, 1000);
    expect(phase(a)).toBe("reconnecting");
    await advanceAndSettle(w.clock, 3_000, 500);
    expect(a.c.state.value).toMatchObject({ phase: "ended", error: { code: "signaling-unavailable" } });
    void b;
  });

  it("pagehide sends leave + bye so others drop the tile immediately", async () => {
    const w = createWorld();
    const a = await startCall(w);
    const b = await joinCall(w, a.c.state.value.link!, "Bob");
    b.win.fire("pagehide");
    await settle(20);
    expect(a.c.state.value.participants).toEqual([]);
    const leaves = w.server.received.filter((r) => typeof r.msg !== "string" && r.msg.t === "leave");
    expect(leaves).toHaveLength(1);
  });

  it("pagehide writes `leave` to the socket synchronously, before any ctl bye", async () => {
    const w = createWorld();
    const a = await startCall(w);
    const order: string[] = [];
    const Base = w.server.WebSocket as unknown as new (url: string) => { send(d: string): void };
    const Spy = class extends Base {
      override send(d: string) {
        order.push(`ws:${d}`);
        super.send(d);
      }
    };
    const b = createParticipant(w, { WebSocket: Spy as unknown as typeof w.server.WebSocket });
    await b.c.prepare({ link: a.c.state.value.link! });
    await settle();
    await b.c.join("Bob");
    await settle(60);
    expectConnected([a, b]);
    const origSend = FakeDataChannel.prototype.send;
    const spy = vi.spyOn(FakeDataChannel.prototype, "send").mockImplementation(function (
      this: FakeDataChannel,
      d,
    ) {
      order.push(`dc:${d}`);
      origSend.call(this, d);
    });
    order.length = 0;
    b.win.fire("pagehide");
    const sync = [...order]; // nothing may wait for a microtask: the document is going away
    spy.mockRestore();
    expect(sync[0]).toBe('ws:{"t":"leave"}');
    expect(sync.slice(1).some((x) => x.startsWith("dc:") && x.includes("bye"))).toBe(true);
    await settle(20);
    expect(a.c.state.value.participants).toEqual([]);
  });

  it("reload whose `leave` was lost: the reloaded tab never lists its own away ghost; it drops on peer-left", async () => {
    const w = createWorld();
    const a = await startCall(w);
    const link = a.c.state.value.link!;
    const b = await joinCall(w, link, "Bob");
    const oldB = b.c.peerId!;
    // Firefox reload: neither `leave` nor `bye` arrive. The old peerId is away server-side for the grace window.
    w.rtc.env.blocked = true;
    w.server.dropPeer(oldB);
    await settle(5);
    b.c.dispose();
    w.rtc.env.blocked = false;
    const b2 = createParticipant(w);
    const seen: { phase: string; ids: string[] }[] = [];
    b2.c.state.subscribe((st) => seen.push({ phase: st.phase, ids: st.participants.map((p) => p.id) }));
    await b2.c.prepare({ link });
    await settle();
    await b2.c.join("Bob");
    await settle(90);
    // Never listed, not even for the round trip until the server's unknown-peer; no empty in-call flash either.
    expect(new Set(seen.flatMap((x) => x.ids))).toEqual(new Set([a.c.peerId]));
    expect(seen.find((x) => x.phase === "in-call")?.ids).toEqual([a.c.peerId]);
    expect(b2.c.state.value.participants.map((p) => p.id)).toEqual([a.c.peerId]);
    expect(b2.c.state.value.participants[0]).toMatchObject({ name: "Ann", status: "connected" });
    await advanceAndSettle(w.clock, 21_000, 1_000);
    expectConnected([a, b2]);
  });

  it("joining a room enters in-call with the other participants already listed (no empty flash)", async () => {
    const w = createWorld();
    const a = await startCall(w);
    const b = createParticipant(w);
    const atInCall: string[][] = [];
    b.c.state.subscribe((st) => {
      if (st.phase === "in-call" && !atInCall.length) atInCall.push(st.participants.map((p) => p.id));
    });
    await b.c.prepare({ link: a.c.state.value.link! });
    await settle();
    await b.c.join("Bob");
    await settle(60);
    expect(atInCall).toEqual([[a.c.peerId]]);
  });

  it("browser-silenced camera: local camOn and the ctl state peers see follow mute/unmute", async () => {
    const w = createWorld();
    const a = await startCall(w);
    const b = await joinCall(w, a.c.state.value.link!, "Bob");
    const cam = b.c.state.value.local.stream!.getVideoTracks()[0] as unknown as FakeTrack;
    cam.setMuted(true);
    await settle(20);
    expect(b.c.state.value.local.camOn).toBe(false);
    expect(a.c.state.value.participants[0]!.camOn).toBe(false); // remote shows the camera-off avatar
    cam.setMuted(false);
    await settle(20);
    expect(b.c.state.value.local.camOn).toBe(true);
    expect(a.c.state.value.participants[0]!.camOn).toBe(true);
  });

  it("mesh of 4: everyone connected, every pair 3 m-lines, 600 kbps cap", async () => {
    const w = createWorld();
    const a = await startCall(w, "A");
    const link = a.c.state.value.link!;
    const ps = [a, await joinCall(w, link, "B"), await joinCall(w, link, "C"), await joinCall(w, link, "D")];
    await settle(60);
    expectConnected(ps);
    const pcs = w.rtc.pcs().filter((pc) => asFake(pc).signalingState !== "closed");
    expect(pcs).toHaveLength(12);
    for (const pc of pcs) {
      expect(asFake(pc).mlineCount).toBe(3);
      expect(asFake(pc).getTransceivers()[1]!.sender.params.encodings[0]!.maxBitrate).toBe(600_000);
    }
  });

  it("fatal code mapping", () => {
    expect(fatalToError("room-full")).toBe("room-full");
    expect(fatalToError("version")).toBe("version-mismatch");
    expect(fatalToError("unavailable")).toBe("signaling-unavailable");
    expect(fatalToError("duplicate-peer")).toBe("signaling-unavailable");
    expect(fatalToError("replaced")).toBeNull();
  });
});

describe("join before local media is ready (regression: first live call sent no media)", () => {
  it("attaches camera + mic to every pair even when Join is tapped while getUserMedia is still pending", async () => {
    const w = createWorld();
    const host = await startCall(w, "Ann");
    const link = host.c.state.value.link!;

    const guest = createParticipant(w);
    let release!: () => void;
    guest.devices.gate = new Promise<void>((r) => {
      release = r;
    });
    void guest.c.prepare({ link }); // UI does not await prepare before the user can tap Join
    await settle();
    const joining = guest.c.join("Bob");
    await settle(30);
    release();
    await joining;
    await advanceAndSettle(w.clock, 2_000, 200);

    expectConnected([host, guest]);
    const live = (p: Participant) =>
      p.devices.issued
        .filter((t) => t.readyState === "live")
        .map((t) => t.kind)
        .sort();
    expect(live(guest)).toEqual(["audio", "video"]);
    // The guest's pair must actually send its live camera + mic tracks.
    const guestTracks = new Set(guest.devices.issued.filter((t) => t.readyState === "live"));
    const sending = w.rtc
      .pcs()
      .flatMap((pc) => pc.getSenders())
      .map((sn) => sn.track)
      .filter((t) => t && guestTracks.has(t as never))
      .map((t) => t!.kind)
      .sort();
    expect(sending).toEqual(["audio", "video"]);
  });
});

describe("controller audio, speaker, sharing", () => {
  it("autoplay rejection → audioBlocked; resumeAudio from a gesture clears it", async () => {
    const w = createWorld();
    const a = await startCall(w);
    FakeAudioEl.playImpl = () =>
      Promise.reject(Object.assign(new Error("gesture"), { name: "NotAllowedError" }));
    try {
      await joinCall(w, a.c.state.value.link!, "Bob");
      await settle(20);
      expect(a.c.state.value.audioBlocked).toBe(true);
      FakeAudioEl.playImpl = null;
      await a.c.resumeAudio();
      expect(a.c.state.value.audioBlocked).toBe(false);
    } finally {
      FakeAudioEl.playImpl = null;
    }
  });

  it("active speaker from remote audio levels with hysteresis", async () => {
    const w = createWorld();
    const a = await startCall(w, "A");
    const link = a.c.state.value.link!;
    const b = await joinCall(w, link, "B");
    const c = await joinCall(w, link, "C");
    await settle(30);
    const recv = (from: Participant) => {
      const pc = w.rtc
        .pcs()
        .map(asFake)
        .find(
          (x) =>
            x.signalingState !== "closed" &&
            a.c.state.value.participants.some((p) => p.id === from.c.peerId) &&
            // the pc in A's mesh whose remote is `from`
            (a.c.transport as unknown as { roster: Map<string, { session: { pc: unknown } }> }).roster.get(
              from.c.peerId!,
            )?.session.pc === x,
        )!;
      return pc.getTransceivers()[0]!.receiver;
    };
    recv(b).audioLevel = 0.5;
    await advanceAndSettle(w.clock, 400, 200);
    expect(a.c.state.value.activeSpeakerId).toBe(b.c.peerId);
    expect(a.c.state.value.participants.find((p) => p.id === b.c.peerId)!.speaking).toBe(true);
    recv(b).audioLevel = 0;
    recv(c).audioLevel = 0.5;
    await advanceAndSettle(w.clock, 600, 200);
    expect(a.c.state.value.activeSpeakerId).toBe(b.c.peerId); // held
    await advanceAndSettle(w.clock, 1200, 200);
    expect(a.c.state.value.activeSpeakerId).toBe(c.c.peerId);
  });

  it("shareLink: Web Share, cancel, clipboard fallback", async () => {
    const w = createWorld();
    const share = vi.fn(async () => {});
    const writeText = vi.fn(async () => {});
    const p = createParticipant(w, { navigator: { share, clipboard: { writeText } } });
    expect(await p.c.shareLink()).toBe("cancelled"); // no link yet
    await p.c.prepare({});
    await settle();
    expect(await p.c.shareLink()).toBe("shared");
    expect(share).toHaveBeenCalledWith({ url: p.c.state.value.link, title: "Clearcall" });
    share.mockRejectedValueOnce(Object.assign(new Error(), { name: "AbortError" }));
    expect(await p.c.shareLink()).toBe("cancelled");
    share.mockRejectedValueOnce(Object.assign(new Error(), { name: "NotAllowedError" }));
    expect(await p.c.shareLink()).toBe("copied");
    expect(writeText).toHaveBeenCalledWith(p.c.state.value.link);
    const q = createParticipant(w, { navigator: { clipboard: { writeText } } });
    await q.c.prepare({});
    await settle();
    expect(await q.c.shareLink()).toBe("copied");
  });

  it("wake lock during the call, released on leave", async () => {
    const w = createWorld();
    const release = vi.fn(async () => {});
    const request = vi.fn(async () => ({ release }));
    const p = createParticipant(w, { navigator: { wakeLock: { request } } });
    await p.c.prepare({});
    await settle();
    await p.c.join("Ann");
    await settle(20);
    expect(request).toHaveBeenCalledWith("screen");
    p.c.leave();
    expect(release).toHaveBeenCalled();
  });

  it("hidden tab asks peers to pause video to us", async () => {
    const w = createWorld();
    const a = await startCall(w);
    const b = await joinCall(w, a.c.state.value.link!, "Bob");
    a.c.reportView(b.c.peerId!, 300);
    await settle(20);
    a.doc.setVisibility("hidden");
    await settle(20);
    const bPc = (
      b.c.transport as unknown as { roster: Map<string, { session: { pc: unknown } }> }
    ).roster.get(a.c.peerId!)!.session.pc;
    expect(asFake(bPc).getTransceivers()[1]!.sender.params.encodings[0]!.active).toBe(false);
  });
});

describe("QA hook", () => {
  it("is installed with ?qa=1 and exposes state, logs, transport, stats timeline and faults", async () => {
    const w = createWorld();
    const a = await startCall(w);
    const b = await joinCall(w, a.c.state.value.link!, "Bob");
    const hook = a.qaTarget.__clearcall as QaHook;
    expect(hook).toBeDefined();
    expect(hook.state().phase).toBe("in-call");
    expect(hook.transport()).toBe("mesh");
    expect(hook.logs().some((e) => e.scope === "controller" && e.msg === "phase")).toBe(true);
    expect(JSON.stringify(hook.logs())).not.toContain("Bob"); // no names in logs
    const stats = await hook.stats();
    expect(stats).toHaveLength(1);
    expect(stats[0]!.id).toBe(b.c.peerId);
    await advanceAndSettle(w.clock, 3000, 500);
    expect(hook.statsTimeline().length).toBeGreaterThanOrEqual(2);

    hook.inject("drop-signaling");
    await settle(5);
    expect(hook.state().phase).toBe("reconnecting");
    await advanceAndSettle(w.clock, 1000, 100);
    expect(hook.state().phase).toBe("in-call");

    hook.inject("restart-ice", b.c.peerId!);
    await settle(30);
    expectConnected([a, b]);

    hook.inject("kill-peer", b.c.peerId!);
    await advanceAndSettle(w.clock, 100, 50);
    await settle(60);
    expectConnected([a, b]);
    expect(await hook.stopRecording(b.c.peerId!)).toBeNull();
  });

  it("is not installed without ?qa=1 and is removed on dispose", async () => {
    const w = createWorld();
    const p = createParticipant(w, {
      flags: { red: false, debug: false, qa: false, telemetry: false },
    });
    expect(p.qaTarget.__clearcall).toBeUndefined();
    const q = createParticipant(w);
    expect(q.qaTarget.__clearcall).toBeDefined();
    q.c.dispose();
    expect(q.qaTarget.__clearcall).toBeUndefined();
    expect(q.win.count("pagehide")).toBe(0);
  });
});

describe("stats consumers keep independent baselines (regression: QA polling zeroed sampler kbps)", () => {
  it("interleaved QA polls do not distort the 1 Hz timeline's kbps", async () => {
    const w = createWorld();
    const host = await startCall(w, "Ann");
    await joinCall(w, host.c.state.value.link!, "Bob");
    await advanceAndSettle(w.clock, 1_000, 100);
    // Outbound bytes grow 1 MB per fake second (8000 kbps) but, like real browsers, the counter only
    // advances in 250 ms steps — a poll a few ms before the sampler tick sees the same value.
    for (const pc of w.rtc.pcs()) {
      asFake(pc).statsFn = () =>
        new Map([
          [
            "o1",
            {
              type: "outbound-rtp",
              kind: "video",
              bytesSent: Math.floor(w.clock.now() / 250) * 250_000,
              framesEncoded: 1,
            },
          ],
        ]);
    }
    const qa = host.qaTarget.__clearcall as QaHook;
    for (let i = 0; i < 6; i++) {
      await advanceAndSettle(w.clock, 995, 5);
      await qa.stats(); // a probe polling ~5 ms before the sampler tick
      await advanceAndSettle(w.clock, 5, 5);
    }
    const recent = qa.statsTimeline().slice(-3);
    expect(recent.length).toBe(3);
    for (const s of recent) {
      const kbps = s.peers[0]?.outboundKbps ?? 0;
      expect(kbps).toBeGreaterThan(7000);
      expect(kbps).toBeLessThan(9000);
    }
  }, 20_000); // wall-clock budget: ~1200 settle steps take ~5 s alone, more when suites run in parallel
});

describe("video codec order per engine (fix/firefox-3party-stall)", () => {
  const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0";
  const SAFARI =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15";
  const video = ["video/VP8", "video/VP9", "video/H264", "video/AV1"].map((mimeType) => ({
    mimeType,
    clockRate: 90000,
  }));
  // What both Firefox 157 and Safari report for type "webrtc": only H264 is power-efficient.
  const mediaCapabilities = {
    encodingInfo: async (cfg: unknown) => ({
      supported: true,
      powerEfficient: (cfg as { video: { contentType: string } }).video.contentType.startsWith("video/H264"),
    }),
  };
  const firstVideoCodec = (w: World) => {
    const pc = asFake(w.rtc.pcs()[0]);
    const prefs = pc.getTransceivers().find((t) => t.kind === "video")!.codecPreferences as
      | { mimeType: string }[]
      | null;
    return prefs?.[0]?.mimeType;
  };

  it.each([
    [
      "Firefox: H264's power-efficient claim is ignored → tier order (AV1 first at 2 people)",
      FIREFOX,
      "video/AV1",
    ],
    ["Safari: hardware H264 first", SAFARI, "video/H264"],
  ])("%s", async (_n, userAgent, expected) => {
    const w = createWorld();
    const deps = { userAgent, mediaCapabilities, getCapabilities: () => ({ codecs: video }) };
    const host = createParticipant(w, deps);
    await host.c.prepare({});
    await settle();
    await host.c.join("Ann");
    await settle(30);
    const guest = createParticipant(w, deps);
    await guest.c.prepare({ link: host.c.state.value.link! });
    await settle();
    await guest.c.join("Bob");
    await settle(60);
    expectConnected([host, guest]);
    expect(firstVideoCodec(w)).toBe(expected);
  });
});
