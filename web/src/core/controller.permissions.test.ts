/**
 * Permission coach engine behaviour: no camera/mic prompt without a tap, requestMedia(), auto re-acquire only on a
 * reported grant, listen-only joins and late grants handed to every pair without renegotiation.
 */
import { describe, expect, it } from "vitest";
import { advanceAndSettle, settle } from "./testing/fake-clock.ts";
import type { FakePeerConnection } from "./testing/fake-webrtc.ts";
import { createParticipant, createWorld, type Participant, type World } from "./testing/harness.ts";

const local = (p: Participant) => p.c.state.value.local;
const gum = (p: Participant) => p.devices.calls.length;
const asked = (p: Participant) =>
  p.devices.calls.map((c) => (["audio", "video"] as const).filter((k) => !!c[k]).join("+"));
const mediaLogs = (p: Participant) =>
  p.c.log
    .entries()
    .filter((e) => e.msg === "mediaRequest")
    .map((e) => `${e.data?.from}->${e.data?.to}:${e.data?.why}`);

/** A fresh visitor: the browser has not decided anything yet. */
function visitor(w: World, state = "prompt", overrides: Parameters<typeof createParticipant>[1] = {}) {
  const p = createParticipant(w, overrides);
  p.perms.setBoth(state);
  return p;
}

async function host(w: World) {
  const h = createParticipant(w);
  await h.c.prepare({});
  await settle();
  await h.c.join("Ann");
  await settle(30);
  return h;
}

function offersBy(pcs: FakePeerConnection[]) {
  return pcs.reduce(
    (n, pc) => n + pc.sdpLog.filter((x) => x.dir === "local" && x.type === "offer").length,
    0,
  );
}

describe("prepare: no prompt on page load", () => {
  it("not decided yet → lobby with mediaRequest not-asked, no getUserMedia, mic/cam off", async () => {
    const w = createWorld();
    const p = visitor(w);
    await p.c.prepare({});
    await settle();
    expect(p.c.state.value.phase).toBe("lobby");
    expect(p.c.state.value.error).toBeNull();
    expect(gum(p)).toBe(0);
    expect(local(p)).toMatchObject({ mediaRequest: "not-asked", micOn: false, camOn: false, stream: null });
    expect(mediaLogs(p)).toEqual(["done->not-asked:prepare"]);
    const permLog = p.c.log.entries().find((e) => e.msg === "permissions");
    expect(permLog?.data).toEqual({ audio: "prompt", video: "prompt", browser: "desktop-other" });
  });

  it("no Permissions API, or one that rejects 'camera' (Firefox), or hangs → not-asked", async () => {
    const w = createWorld();
    const none = createParticipant(w, { permissions: undefined });
    await none.c.prepare({});
    await settle();
    expect(local(none).mediaRequest).toBe("not-asked");
    expect(gum(none)).toBe(0);

    const ff = createParticipant(w);
    ff.perms.throws.add("camera");
    await ff.c.prepare({});
    await settle();
    expect(local(ff).mediaRequest).toBe("not-asked");
    expect(gum(ff)).toBe(0);

    const hang = createParticipant(w);
    hang.perms.gate = new Promise(() => {});
    const prep = hang.c.prepare({});
    await settle();
    expect(hang.c.state.value.phase).toBe("idle"); // lobby waits for the answer…
    await advanceAndSettle(w.clock, 600);
    await prep;
    expect(hang.c.state.value.phase).toBe("lobby"); // …but not forever
    expect(local(hang).mediaRequest).toBe("not-asked");
    expect(gum(hang)).toBe(0);
  });

  it("both granted (returning visitor, quality lab, E2E) → camera + mic at once, never 'asking'", async () => {
    const w = createWorld();
    const p = createParticipant(w);
    await p.c.prepare({});
    await settle();
    expect(gum(p)).toBe(1);
    expect(local(p)).toMatchObject({ mediaRequest: "done", micOn: true, camOn: true });
    expect(local(p).stream!.getTracks()).toHaveLength(2);
    expect(mediaLogs(p)).toEqual(["done->done:granted"]);
  });

  it("either denied → straight to blocked help: done + permission-denied, no getUserMedia", async () => {
    const w = createWorld();
    const p = visitor(w);
    p.perms.set("camera", "denied");
    await p.c.prepare({});
    await settle();
    expect(gum(p)).toBe(0);
    expect(p.c.state.value.error).toEqual({ code: "permission-denied", detail: "permissions-api" });
    expect(local(p)).toMatchObject({
      mediaRequest: "done",
      camAvailable: false,
      micAvailable: true,
      micOn: false,
      camOn: false,
    });
  });
});

describe("requestMedia", () => {
  it("tap → asking → done with camera + mic; a second tap while asking is a no-op", async () => {
    const w = createWorld();
    const p = visitor(w);
    await p.c.prepare({});
    await settle();
    let allow!: () => void;
    p.devices.gate = new Promise((r) => {
      allow = r;
    });
    const req = p.c.requestMedia();
    await settle();
    expect(local(p).mediaRequest).toBe("asking");
    await p.c.requestMedia(); // double tap
    expect(gum(p)).toBe(1);
    allow();
    await req;
    expect(local(p)).toMatchObject({ mediaRequest: "done", micOn: true, camOn: true, camAvailable: true });
    expect(p.c.state.value.error).toBeNull();
    expect(asked(p)).toEqual(["audio+video"]);
    expect(mediaLogs(p)).toEqual(["done->not-asked:prepare", "not-asked->asking:tap", "asking->done:tap"]);
  });

  it("sound only → asks for the mic alone; camera unavailable and off", async () => {
    const w = createWorld();
    const p = visitor(w);
    await p.c.prepare({});
    await settle();
    await p.c.requestMedia({ video: false });
    expect(asked(p)).toEqual(["audio"]);
    expect(local(p)).toMatchObject({ mediaRequest: "done", micOn: true, camOn: false, camAvailable: false });
    // later, the lobby camera button asks for the camera only (mic untouched)
    await p.c.setCam(true);
    expect(asked(p)).toEqual(["audio", "video"]);
    expect(local(p)).toMatchObject({ micOn: true, camOn: true, camAvailable: true });
  });

  it("dismissed/blocked prompt → exactly one getUserMedia, blocked help; no per-device re-ask", async () => {
    const w = createWorld();
    const p = visitor(w);
    await p.c.prepare({});
    await settle();
    p.devices.fail = { audio: "NotAllowedError", video: "NotAllowedError" };
    await p.c.requestMedia();
    expect(gum(p)).toBe(1);
    expect(p.c.state.value.error?.code).toBe("permission-denied");
    expect(local(p)).toMatchObject({ mediaRequest: "done", micAvailable: false, camAvailable: false });
    // the page going hidden/visible must not prompt again
    p.doc.setVisibility("hidden");
    p.doc.setVisibility("visible");
    p.devices.fireDeviceChange();
    await settle();
    expect(gum(p)).toBe(1);
  });

  it("camera blocked but mic already granted → the mic is retried alone (no prompt possible)", async () => {
    const w = createWorld();
    const p = visitor(w);
    p.perms.set("microphone", "granted");
    await p.c.prepare({});
    await settle();
    p.devices.fail = { video: "NotAllowedError" };
    await p.c.requestMedia();
    expect(asked(p)).toEqual(["audio+video", "audio"]);
    expect(local(p)).toMatchObject({ micAvailable: true, micOn: true, camAvailable: false });
  });

  it("'I've done it — try again' re-asks without a new link or teardown", async () => {
    const w = createWorld();
    const p = visitor(w);
    await p.c.prepare({});
    await settle();
    const link = p.c.state.value.link;
    p.devices.fail = { audio: "NotAllowedError", video: "NotAllowedError" };
    await p.c.requestMedia();
    p.devices.fail = {};
    await p.c.requestMedia();
    expect(p.c.state.value).toMatchObject({ phase: "lobby", link, error: null });
    expect(local(p)).toMatchObject({ mediaRequest: "done", micOn: true, camOn: true });
    expect(p.replaceState).toHaveLength(1);
  });

  it("'Start a call': prepare() and requestMedia() back to back from one tap", async () => {
    const w = createWorld();
    const p = visitor(w);
    const prep = p.c.prepare({});
    const req = p.c.requestMedia();
    await prep;
    await req;
    expect(asked(p)).toEqual(["audio+video"]);
    expect(local(p)).toMatchObject({ mediaRequest: "done", micOn: true, camOn: true });
  });
});

describe("auto re-acquire only on a reported grant", () => {
  async function blocked(w: World, overrides: Parameters<typeof createParticipant>[1] = {}) {
    const p = visitor(w, "denied", overrides);
    await p.c.prepare({});
    await settle();
    expect(local(p).mediaRequest).toBe("done");
    expect(p.c.state.value.error?.code).toBe("permission-denied");
    return p;
  }

  it("permission change → granted re-acquires without a tap; other changes do nothing", async () => {
    const w = createWorld();
    const p = await blocked(w);
    p.perms.change("camera", "prompt");
    await settle();
    expect(gum(p)).toBe(0);
    p.perms.set("microphone", "granted");
    p.perms.change("camera", "granted");
    await settle();
    expect(asked(p)).toEqual(["audio+video"]);
    expect(p.c.state.value.error).toBeNull();
    expect(local(p)).toMatchObject({ mediaRequest: "done", micOn: true, camOn: true });
    expect(p.c.log.entries().some((e) => e.msg === "permission granted: re-acquiring")).toBe(true);
  });

  it("back from Settings (visible) re-queries; only kinds now granted are captured", async () => {
    const w = createWorld();
    const p = await blocked(w);
    p.doc.setVisibility("hidden");
    p.doc.setVisibility("visible");
    await settle();
    expect(gum(p)).toBe(0); // still denied: nothing
    p.perms.set("camera", "granted"); // Safari: changed silently, no event
    p.doc.setVisibility("hidden");
    p.doc.setVisibility("visible");
    await settle();
    expect(asked(p)).toEqual(["video"]); // the mic is still blocked: never asked
    expect(local(p)).toMatchObject({ camOn: true, camAvailable: true, micAvailable: false });
    expect(p.c.state.value.error).toEqual({ code: "permission-denied", detail: "audio:denied" }); // help stays up
    p.perms.change("microphone", "granted");
    await settle();
    expect(asked(p)).toEqual(["video", "audio"]);
    expect(p.c.state.value.error).toBeNull();
    expect(local(p)).toMatchObject({ micOn: true, camOn: true });
  });

  it("no Permissions API → never re-acquires by itself", async () => {
    const w = createWorld();
    const p = visitor(w, "prompt", { permissions: undefined });
    await p.c.prepare({});
    await settle();
    p.devices.fail = { audio: "NotAllowedError", video: "NotAllowedError" };
    await p.c.requestMedia();
    p.devices.fail = {};
    p.doc.setVisibility("hidden");
    p.doc.setVisibility("visible");
    await settle();
    expect(gum(p)).toBe(1);
  });

  it("sound only after a blocked camera: the camera is not brought back by a later grant", async () => {
    const w = createWorld();
    const p = visitor(w);
    p.perms.set("camera", "denied");
    await p.c.prepare({});
    await settle();
    await p.c.requestMedia({ video: false });
    expect(asked(p)).toEqual(["audio"]);
    expect(p.c.state.value.error).toBeNull();
    p.perms.change("camera", "granted");
    await settle();
    expect(asked(p)).toEqual(["audio"]);
  });
});

describe("listen-only joins and late grants", () => {
  it("join from not-asked → in call at once, listening; a grant reaches every pair via replaceTrack, no new offer", async () => {
    const w = createWorld();
    const a = await host(w);
    const link = a.c.state.value.link!;
    const b = createParticipant(w);
    await b.c.prepare({ link });
    await settle();
    await b.c.join("Bob");
    await settle(60);
    const c = visitor(w);
    const pcsBefore = w.rtc.pcs().length;
    await c.c.prepare({ link });
    await settle();
    await c.c.join("Cy");
    await settle(60);
    expect(c.c.state.value.phase).toBe("in-call");
    expect(gum(c)).toBe(0);
    for (const x of [a, b]) {
      const cy = x.c.state.value.participants.find((r) => r.name === "Cy")!;
      expect(cy).toMatchObject({ status: "connected", micOn: false, camOn: false });
    }
    const pcs = c.c.transport!.participants().length;
    expect(pcs).toBe(2);
    // The newcomer offers, so its pcs are the new ones that added transceivers (answerers never do).
    const cPcs = (w.rtc.pcs().slice(pcsBefore) as unknown as FakePeerConnection[]).filter(
      (pc) => pc.addTransceiverCalls > 0,
    );
    expect(cPcs).toHaveLength(2);
    const offersBefore = offersBy(cPcs);
    const sendersBefore = cPcs.flatMap((pc) => pc.getSenders());
    expect(sendersBefore.every((s) => s.track === null)).toBe(true);

    await c.c.requestMedia();
    await settle(60);
    expect(local(c)).toMatchObject({ mediaRequest: "done", micOn: false, camOn: true }); // the tap asked for the camera
    const live = new Set(c.devices.issued.filter((t) => t.readyState === "live"));
    expect(live.size).toBe(2);
    for (const pc of cPcs) {
      const kinds = pc
        .getSenders()
        .filter((s) => s.track && live.has(s.track))
        .map((s) => s.track!.kind)
        .sort();
      expect(kinds).toEqual(["audio", "video"]);
      for (const s of pc.getSenders()) expect(s.replaceTrackCalls.length).toBeGreaterThan(0);
    }
    expect(offersBy(cPcs)).toBe(offersBefore);
    expect(cPcs.every((pc) => pc.getTransceivers().length === 2)).toBe(true);
    for (const x of [a, b]) {
      const cy = x.c.state.value.participants.find((r) => r.name === "Cy")!;
      expect(cy).toMatchObject({ camOn: true, micOn: false });
    }
  });

  it("listen-only → mic tap asks for the mic only, unmutes it, re-plays remote audio (iOS audio session)", async () => {
    const w = createWorld();
    const a = await host(w);
    const b = visitor(w);
    await b.c.prepare({ link: a.c.state.value.link! });
    await settle();
    await b.c.join("Bob");
    await settle(60);
    expect(b.audioEls).toHaveLength(1);
    b.audioEls[0]!.pause();
    b.c.setMic(true);
    await settle(60);
    expect(asked(b)).toEqual(["audio"]);
    expect(local(b)).toMatchObject({ micOn: true, camOn: false, mediaRequest: "done" });
    expect(b.audioEls[0]!.playing).toBe(true);
    expect(a.c.state.value.participants[0]).toMatchObject({ micOn: true, camOn: false });
    // the camera tap later never mutes/unmutes the mic, and asks for the camera only
    b.c.setMic(false);
    await b.c.setCam(true);
    await settle(60);
    expect(asked(b)).toEqual(["audio", "video"]);
    expect(local(b)).toMatchObject({ micOn: false, camOn: true });
  });

  it("listen-only → camera tap: one prompt for both, the mic stays muted", async () => {
    const w = createWorld();
    const a = await host(w);
    const b = visitor(w);
    await b.c.prepare({ link: a.c.state.value.link! });
    await settle();
    await b.c.join("Bob");
    await settle(60);
    await b.c.setCam(true);
    await settle(60);
    expect(asked(b)).toEqual(["audio+video"]);
    expect(local(b)).toMatchObject({ micOn: false, camOn: true, micAvailable: true });
    expect(a.c.state.value.participants[0]).toMatchObject({ micOn: false, camOn: true });
  });

  it("join while the prompt is up waits for the answer (bounded) so the first offer carries the tracks", async () => {
    const w = createWorld();
    const a = await host(w);
    const b = visitor(w);
    await b.c.prepare({ link: a.c.state.value.link! });
    await settle();
    let allow!: () => void;
    b.devices.gate = new Promise((r) => {
      allow = r;
    });
    void b.c.requestMedia();
    await settle();
    const joining = b.c.join("Bob");
    await settle(30);
    expect(b.c.transport).toBeNull(); // still waiting on the prompt
    allow();
    await joining;
    await advanceAndSettle(w.clock, 2_000, 200);
    expect(b.c.state.value.phase).toBe("in-call");
    expect(a.c.state.value.participants[0]).toMatchObject({ micOn: true, camOn: true });
  });

  it("an in-call refusal leaves the call intact (no error phase), and a later grant is picked up", async () => {
    const w = createWorld();
    const a = await host(w);
    const b = visitor(w);
    await b.c.prepare({ link: a.c.state.value.link! });
    await settle();
    await b.c.join("Bob");
    await settle(60);
    b.devices.fail = { audio: "NotAllowedError" };
    b.c.setMic(true);
    await settle(60);
    expect(b.c.state.value).toMatchObject({ phase: "in-call", error: null });
    expect(local(b)).toMatchObject({ micOn: false, micAvailable: false, mediaRequest: "done" });
    b.devices.fail = {};
    b.perms.change("microphone", "granted");
    await settle(60);
    expect(local(b)).toMatchObject({ micOn: true, micAvailable: true });
    expect(asked(b)).toEqual(["audio", "audio"]);
  });
});
