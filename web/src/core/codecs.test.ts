import { describe, expect, it, vi } from "vitest";
import {
  applyCodecPreferences,
  audioCodecOrder,
  chooseVideoCodecOrder,
  codecTier,
  forcedVideoOrder,
  orderCodecs,
  tierVideoPreference,
} from "./codecs.ts";
import { videoLabFlags } from "./deps.ts";

const c = (mimeType: string, sdpFmtpLine?: string) => ({
  mimeType,
  clockRate: mimeType.startsWith("audio") ? 48000 : 90000,
  ...(sdpFmtpLine ? { sdpFmtpLine } : {}),
});

const AUDIO = [c("audio/opus"), c("audio/red"), c("audio/G722"), c("audio/PCMU"), c("audio/telephone-event")];
const VIDEO = [
  c("video/VP8"),
  c("video/rtx"),
  c("video/VP9", "profile-id=0"),
  c("video/H264", "profile-level-id=42e01f"),
  c("video/AV1"),
  c("video/red"),
  c("video/ulpfec"),
];

describe("codec ordering", () => {
  it("stable reorder keeps unknown codecs (rtx/fec) after preferred ones", () => {
    const out = orderCodecs(VIDEO, ["video/H264", "video/VP8"]).map((x) => x.mimeType);
    expect(out).toEqual([
      "video/H264",
      "video/VP8",
      "video/rtx",
      "video/VP9",
      "video/AV1",
      "video/red",
      "video/ulpfec",
    ]);
  });

  it("RED off by default: removed, opus first", () => {
    expect(audioCodecOrder(AUDIO, false).map((x) => x.mimeType)).toEqual([
      "audio/opus",
      "audio/G722",
      "audio/PCMU",
      "audio/telephone-event",
    ]);
  });

  it("RED on: red then opus", () => {
    const reversed = [...AUDIO].reverse();
    expect(
      audioCodecOrder(reversed, true)
        .map((x) => x.mimeType)
        .slice(0, 2),
    ).toEqual(["audio/red", "audio/opus"]);
  });
});

describe("chooseVideoCodecOrder", () => {
  it("returns only the power-efficient codecs (they go before the tier order)", async () => {
    const encodingInfo = vi.fn(async (cfg: { video: { contentType: string } }) => {
      const ct = cfg.video.contentType;
      if (ct.startsWith("video/VP9")) return { supported: true, powerEfficient: false };
      if (ct.startsWith("video/H264")) return { supported: true, powerEfficient: true };
      return { supported: true, powerEfficient: false };
    });
    const order = await chooseVideoCodecOrder(VIDEO, { encodingInfo });
    expect(order).toEqual(["video/H264"]);
    expect(encodingInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "webrtc",
        video: expect.objectContaining({ contentType: "video/VP9;profile-id=0" }),
      }),
    );
  });

  it("all efficient → probe preference order; none efficient (software only, e.g. headless) → null", async () => {
    const order = await chooseVideoCodecOrder(VIDEO, {
      encodingInfo: async () => ({ supported: true, powerEfficient: true }),
    });
    expect(order).toEqual(["video/VP9", "video/H264", "video/AV1", "video/VP8"]);
    expect(
      await chooseVideoCodecOrder(VIDEO, {
        encodingInfo: async () => ({ supported: true, powerEfficient: false }),
      }),
    ).toBeNull();
  });

  it("falls back to browser default when the API is missing, throws or knows nothing", async () => {
    expect(await chooseVideoCodecOrder(VIDEO, undefined)).toBeNull();
    expect(await chooseVideoCodecOrder(null, { encodingInfo: async () => ({ supported: true }) })).toBeNull();
    expect(
      await chooseVideoCodecOrder(VIDEO, {
        encodingInfo: async () => {
          throw new TypeError("webrtc type unsupported");
        },
      }),
    ).toBeNull();
    expect(
      await chooseVideoCodecOrder([c("video/AV1")], { encodingInfo: async () => ({ supported: false }) }),
    ).toBeNull();
  });
});

describe("applyCodecPreferences", () => {
  it("sets audio prefs, video in tier order (forced/efficient first), swallows errors", () => {
    const setCodecPreferences = vi.fn();
    const t = { setCodecPreferences } as unknown as RTCRtpTransceiver;
    applyCodecPreferences(t, "audio", { codecs: AUDIO }, { red: false, videoOrder: null });
    expect(setCodecPreferences.mock.calls[0]![0].map((x: { mimeType: string }) => x.mimeType)[0]).toBe(
      "audio/opus",
    );
    const mimes = (i: number) =>
      setCodecPreferences.mock.calls[i]![0].map((x: { mimeType: string }) => x.mimeType) as string[];
    applyCodecPreferences(t, "video", { codecs: VIDEO }, { red: false, videoOrder: null }, undefined, 2);
    expect(mimes(1).slice(0, 4)).toEqual([...tierVideoPreference(2)]);
    applyCodecPreferences(t, "video", { codecs: VIDEO }, { red: false, videoOrder: null }, undefined, 8);
    expect(mimes(2).slice(0, 4)).toEqual([...tierVideoPreference(8)]);
    expect(mimes(2)).toContain("video/rtx"); // non-preferred codecs kept after
    applyCodecPreferences(
      t,
      "video",
      { codecs: VIDEO },
      { red: false, videoOrder: ["video/H264"] },
      undefined,
      2,
    );
    expect(mimes(3)[0]).toBe("video/H264");
    const bad = {
      setCodecPreferences: () => {
        throw new Error("InvalidModificationError");
      },
    } as unknown as RTCRtpTransceiver;
    expect(() =>
      applyCodecPreferences(bad, "audio", { codecs: AUDIO }, { red: true, videoOrder: null }),
    ).not.toThrow();
    // no API at all
    expect(() =>
      applyCodecPreferences(
        {} as RTCRtpTransceiver,
        "audio",
        { codecs: AUDIO },
        { red: true, videoOrder: null },
      ),
    ).not.toThrow();
  });
});

describe("forcedVideoOrder (?vcodec=)", () => {
  it("maps known codecs case-insensitively", () => {
    expect(forcedVideoOrder("vp8")).toEqual(["video/VP8"]);
    expect(forcedVideoOrder("H264")).toEqual(["video/H264"]);
    expect(forcedVideoOrder("av1")).toEqual(["video/AV1"]);
  });
  it("videoLabFlags reads ?vcodec= and ?vstart=", () => {
    expect(videoLabFlags("?qa=1&vcodec=VP8&vstart=1200")).toEqual({ vcodec: "vp8", vstart: 1200 });
    expect(videoLabFlags("?vstart=0")).toEqual({ vstart: 0 });
    expect(videoLabFlags("?qa=1&vstart=abc")).toEqual({});
    expect(videoLabFlags("?vstart=99999")).toEqual({});
  });
  it("is null when absent or unknown (data-driven order stays)", () => {
    expect(forcedVideoOrder(undefined)).toBeNull();
    expect(forcedVideoOrder("")).toBeNull();
    expect(forcedVideoOrder("theora")).toBeNull();
  });
  it("puts the forced codec first and keeps the rest as fallback", () => {
    const codecs = [
      { mimeType: "video/VP8", clockRate: 90000 },
      { mimeType: "video/VP9", clockRate: 90000 },
      { mimeType: "video/H264", clockRate: 90000 },
    ];
    expect(orderCodecs(codecs, forcedVideoOrder("h264")!).map((c) => c.mimeType)).toEqual([
      "video/H264",
      "video/VP8",
      "video/VP9",
    ]);
  });
});

describe("tier codec order", () => {
  it("tiers follow ADR-0005 participant counts", () => {
    expect([1, 2, 3, 4, 5, 10].map(codecTier)).toEqual([2, 2, 4, 4, 10, 10]);
  });
  it("every tier lists all four codecs once", () => {
    for (const n of [2, 4, 10])
      expect([...tierVideoPreference(n)].sort()).toEqual([
        "video/AV1",
        "video/H264",
        "video/VP8",
        "video/VP9",
      ]);
  });
});
