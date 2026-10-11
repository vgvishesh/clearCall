import { describe, expect, it } from "vitest";
import { audioConstraints, classifyMediaError, LocalMedia, meterLevel, videoConstraints } from "./media.ts";
import { advanceAndSettle, FakeClock, settle } from "./testing/fake-clock.ts";
import { FakeAudioContext, FakeDocument, FakeMediaDevices } from "./testing/fake-media.ts";
import { FakeMediaStream, type FakeTrack } from "./testing/fake-webrtc.ts";

function setup() {
  const devices = new FakeMediaDevices();
  const doc = new FakeDocument();
  const ctx = new FakeAudioContext();
  const clock = new FakeClock();
  const trackEvents: [string, FakeTrack | null][] = [];
  const audioSession = { type: "auto" };
  let changes = 0;
  const media = new LocalMedia({
    mediaDevices: devices,
    MediaStream: FakeMediaStream as unknown as typeof MediaStream,
    clock,
    document: doc,
    navigator: { audioSession },
    createAudioContext: () => ctx,
    onTrack: (k, t) => trackEvents.push([k, t as unknown as FakeTrack | null]),
    onChange: () => changes++,
  });
  return { devices, doc, ctx, clock, media, trackEvents, audioSession, changes: () => changes };
}

const ft = (t: MediaStreamTrack | null) => t as unknown as FakeTrack | null;

describe("constraints", () => {
  it("voice vs music (EC stays on in music)", () => {
    expect(audioConstraints("voice")).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    });
    expect(audioConstraints("music")).toEqual({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    });
    expect(videoConstraints("environment")).toMatchObject({
      facingMode: "environment",
      height: { ideal: 720 },
    });
  });

  it("error classification", () => {
    const e = (name: string) => Object.assign(new Error(), { name });
    expect(classifyMediaError(e("NotAllowedError"))).toBe("permission-denied");
    expect(classifyMediaError(e("SecurityError"))).toBe("permission-denied");
    expect(classifyMediaError(e("NotFoundError"))).toBe("no-devices");
    expect(classifyMediaError(e("NotReadableError"))).toBe("no-devices");
    expect(classifyMediaError(e("OverconstrainedError"))).toBe("no-devices");
    expect(classifyMediaError(new TypeError("x"))).toBe("unsupported");
  });
});

describe("LocalMedia.acquire", () => {
  it("captures audio+video with voice constraints and sets the audio session", async () => {
    const { media, devices, audioSession } = setup();
    expect(await media.acquire()).toBeNull();
    const st = media.state;
    expect(st.audio?.kind).toBe("audio");
    expect(st.video?.kind).toBe("video");
    expect(st.stream!.getTracks()).toHaveLength(2);
    expect(st).toMatchObject({
      micOn: true,
      camOn: true,
      micAvailable: true,
      camAvailable: true,
      canSwitchCamera: true,
    });
    expect(devices.calls[0]).toEqual({ audio: audioConstraints("voice"), video: videoConstraints("user") });
    expect(audioSession.type).toBe("play-and-record");
    expect(media.sourceShortSide).toBe(720);
  });

  it("permission denied for both → lobby error, both unavailable, mic off", async () => {
    const { media, devices } = setup();
    devices.fail = { audio: "NotAllowedError", video: "NotAllowedError" };
    const err = await media.acquire();
    expect(err?.code).toBe("permission-denied");
    expect(media.state).toMatchObject({
      micAvailable: false,
      camAvailable: false,
      micOn: false,
      camOn: false,
    });
  });

  it("missing camera only → audio works, camAvailable=false, no-devices", async () => {
    const { media, devices } = setup();
    devices.fail = { video: "NotFoundError" };
    const err = await media.acquire();
    expect(err).toEqual({ code: "no-devices", detail: "video:NotFoundError" });
    expect(media.state).toMatchObject({ micAvailable: true, camAvailable: false, micOn: true, camOn: false });
    expect(media.state.stream!.getTracks()).toHaveLength(1);
  });

  it("camera denied, mic fine → permission-denied with camAvailable=false", async () => {
    const { media, devices } = setup();
    devices.fail = { video: "NotAllowedError" };
    expect((await media.acquire())?.code).toBe("permission-denied");
    expect(media.state.micAvailable).toBe(true);
    expect(media.state.camAvailable).toBe(false);
  });

  it("single camera → canSwitchCamera false", async () => {
    const { media, devices } = setup();
    devices.devices = devices.devices.filter((d) => d.deviceId !== "cam2");
    await media.acquire();
    expect(media.state.canSwitchCamera).toBe(false);
  });
});

describe("LocalMedia controls", () => {
  it("mic mute is track.enabled (no new capture)", async () => {
    const { media, devices } = setup();
    await media.acquire();
    const n = devices.calls.length;
    media.setMic(false);
    expect(media.state.audio!.enabled).toBe(false);
    media.setMic(true);
    expect(media.state.audio!.enabled).toBe(true);
    expect(devices.calls.length).toBe(n);
  });

  it("camera off stops the track (light off); on re-acquires and hands the new track to the transport", async () => {
    const { media, devices, trackEvents } = setup();
    await media.acquire();
    const old = ft(media.state.video)!;
    await media.setCam(false);
    expect(old.readyState).toBe("ended");
    expect(media.state.video).toBeNull();
    expect(media.state.stream!.getTracks().map((t) => t.kind)).toEqual(["audio"]);
    expect(trackEvents.at(-1)).toEqual(["video", null]);
    await media.setCam(true);
    expect(media.state.camOn).toBe(true);
    expect(trackEvents.at(-1)![1]).toBe(ft(media.state.video));
    expect(devices.overlaps).toEqual([]);
  });

  it("switchCamera stops the old track BEFORE acquiring the other facing (iOS rule)", async () => {
    const { media, devices, trackEvents } = setup();
    await media.acquire();
    await media.switchCamera();
    expect(devices.overlaps).toEqual([]);
    expect(media.state.facing).toBe("environment");
    expect((devices.calls.at(-1)!.video as MediaTrackConstraints).facingMode).toBe("environment");
    expect(devices.live("video")).toHaveLength(1);
    expect(trackEvents.at(-1)![0]).toBe("video");
  });

  it("switchCamera falls back to the old facing when the other camera fails", async () => {
    const { media, devices } = setup();
    await media.acquire();
    const orig = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async (c) => {
      if ((c.video as MediaTrackConstraints | undefined)?.facingMode === "environment")
        throw Object.assign(new Error(), { name: "OverconstrainedError" });
      return orig(c);
    };
    await media.switchCamera();
    expect(media.state.facing).toBe("user");
    expect(media.state.camOn).toBe(true);
  });

  it("setMode re-acquires the mic with music constraints, stop-before-reacquire, keeps mute state", async () => {
    const { media, devices, trackEvents } = setup();
    await media.acquire();
    media.setMic(false);
    const old = ft(media.state.audio)!;
    await media.setMode("music");
    expect(old.readyState).toBe("ended");
    expect(devices.overlaps).toEqual([]);
    expect(devices.calls.at(-1)).toEqual({ audio: audioConstraints("music") });
    expect(media.state.audio!.enabled).toBe(false);
    expect(media.state.mode).toBe("music");
    expect(trackEvents.at(-1)).toEqual(["audio", ft(media.state.audio)]);
  });
});

describe("LocalMedia recovery", () => {
  it("re-acquires an ended camera track (device lost) and replaces it", async () => {
    const { media, trackEvents } = setup();
    await media.acquire();
    const old = ft(media.state.video)!;
    old.end();
    await settle();
    expect(media.state.video).not.toBe(old);
    expect(ft(media.state.video)!.readyState).toBe("live");
    expect(trackEvents.at(-1)).toEqual(["video", ft(media.state.video)]);
  });

  it("iOS background: waits for visibility, then replaces muted/ended tracks", async () => {
    const { media, doc, trackEvents } = setup();
    await media.acquire();
    doc.setVisibility("hidden");
    const cam = ft(media.state.video)!;
    cam.end();
    ft(media.state.audio)!.setMuted(true);
    await settle();
    expect(media.state.video).toBe(cam); // nothing while hidden
    doc.setVisibility("visible");
    await settle();
    expect(media.state.video).not.toBe(cam);
    expect(ft(media.state.audio)!.muted).toBe(false);
    expect(trackEvents.map((e) => e[0]).sort()).toEqual(["audio", "video"]);
  });

  it("does not resurrect a camera the user turned off", async () => {
    const { media, doc, devices } = setup();
    await media.acquire();
    await media.setCam(false);
    const n = devices.calls.length;
    doc.setVisibility("hidden");
    doc.setVisibility("visible");
    await settle();
    expect(devices.calls.length).toBe(n);
  });

  it("browser-muted camera (another page took it) reports camOn=false until unmuted; no re-capture", async () => {
    const { media, devices, changes } = setup();
    await media.acquire();
    const cam = ft(media.state.video)!;
    const n = devices.calls.length;
    const c0 = changes();
    cam.setMuted(true);
    expect(media.state.camOn).toBe(false);
    expect(changes()).toBeGreaterThan(c0);
    await settle();
    expect(devices.calls.length).toBe(n); // visible page: wait for the browser to hand it back
    cam.setMuted(false);
    expect(media.state.camOn).toBe(true);
    expect(media.state.video).toBe(cam);
  });

  it("an ended camera reports camOn=false while hidden, then recovers to camOn=true on visible", async () => {
    const { media, doc } = setup();
    await media.acquire();
    doc.setVisibility("hidden");
    ft(media.state.video)!.end();
    expect(media.state.camOn).toBe(false);
    await settle();
    expect(media.state.camOn).toBe(false);
    doc.setVisibility("visible");
    await settle();
    expect(media.state.camOn).toBe(true);
    expect(ft(media.state.video)!.readyState).toBe("live");
  });

  it("tapping camera on while capture is silenced re-acquires (old track stopped first)", async () => {
    const { media, devices, trackEvents } = setup();
    await media.acquire();
    const cam = ft(media.state.video)!;
    cam.setMuted(true);
    await media.setCam(true);
    expect(cam.readyState).toBe("ended");
    expect(devices.overlaps).toEqual([]);
    expect(media.state.video).not.toBe(cam);
    expect(media.state.camOn).toBe(true);
    expect(trackEvents.at(-1)).toEqual(["video", ft(media.state.video)]);
  });

  it("camera turned off while silenced stays off when the old track unmutes", async () => {
    const { media } = setup();
    await media.acquire();
    const cam = ft(media.state.video)!;
    cam.setMuted(true);
    await media.setCam(false);
    cam.setMuted(false);
    expect(media.state.camOn).toBe(false);
  });

  it("devicechange refreshes canSwitchCamera", async () => {
    const { media, devices } = setup();
    await media.acquire();
    expect(media.state.canSwitchCamera).toBe(true);
    devices.devices = devices.devices.filter((d) => d.deviceId !== "cam2");
    devices.fireDeviceChange();
    await settle();
    expect(media.state.canSwitchCamera).toBe(false);
  });

  it("stop() releases every track and listener", async () => {
    const { media, devices, ctx } = setup();
    await media.acquire();
    media.stop();
    expect(devices.live("audio")).toHaveLength(0);
    expect(devices.live("video")).toHaveLength(0);
    expect(ctx.closed).toBe(true);
    expect(media.state.stream).toBeNull();
  });
});

describe("local level meter", () => {
  it("rises with signal, reports speaking, drops to 0 when muted", async () => {
    const { media, ctx, clock } = setup();
    await media.acquire();
    ctx.amplitude = 0.3;
    await advanceAndSettle(clock, 300, 100);
    expect(media.state.level).toBeGreaterThan(0.5);
    expect(media.state.speaking).toBe(true);
    media.setMic(false);
    await advanceAndSettle(clock, 200, 100);
    expect(media.state.level).toBe(0);
    expect(media.state.speaking).toBe(false);
  });

  it("meterLevel maps dBFS to 0..1 with slow release", () => {
    expect(meterLevel(new Float32Array(64), 0)).toBe(0);
    const loud = new Float32Array(64).fill(1);
    expect(meterLevel(loud, 0)).toBe(1);
    expect(meterLevel(new Float32Array(64), 1)).toBe(0.8);
    const quiet = new Float32Array(64).fill(0.001); // −60 dBFS
    expect(meterLevel(quiet, 0)).toBe(0);
  });
});
