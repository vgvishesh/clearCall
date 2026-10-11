import { describe, expect, it, vi } from "vitest";
import { applyCodecPreferences, audioCodecOrder, chooseVideoCodecOrder, orderCodecs } from "./codecs.ts";

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
  it("prefers power-efficient codecs in VP9 → H264 → VP8 order", async () => {
    const encodingInfo = vi.fn(async (cfg: { video: { contentType: string } }) => {
      const ct = cfg.video.contentType;
      if (ct.startsWith("video/VP9")) return { supported: true, powerEfficient: false };
      if (ct.startsWith("video/H264")) return { supported: true, powerEfficient: true };
      return { supported: true, powerEfficient: false };
    });
    const order = await chooseVideoCodecOrder(VIDEO, { encodingInfo });
    expect(order).toEqual(["video/H264", "video/VP9", "video/VP8"]);
    expect(encodingInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "webrtc",
        video: expect.objectContaining({ contentType: "video/VP9;profile-id=0" }),
      }),
    );
  });

  it("all efficient → pure preference order", async () => {
    const order = await chooseVideoCodecOrder(VIDEO, {
      encodingInfo: async () => ({ supported: true, powerEfficient: true }),
    });
    expect(order).toEqual(["video/VP9", "video/H264", "video/VP8"]);
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
      await chooseVideoCodecOrder([c("video/AV1")], { encodingInfo: async () => ({ supported: true }) }),
    ).toBeNull();
  });
});

describe("applyCodecPreferences", () => {
  it("sets audio prefs, skips video without a decided order, swallows errors", () => {
    const setCodecPreferences = vi.fn();
    const t = { setCodecPreferences } as unknown as RTCRtpTransceiver;
    applyCodecPreferences(t, "audio", { codecs: AUDIO }, { red: false, videoOrder: null });
    expect(setCodecPreferences.mock.calls[0]![0].map((x: { mimeType: string }) => x.mimeType)[0]).toBe(
      "audio/opus",
    );
    applyCodecPreferences(t, "video", { codecs: VIDEO }, { red: false, videoOrder: null });
    expect(setCodecPreferences).toHaveBeenCalledTimes(1);
    applyCodecPreferences(t, "video", { codecs: VIDEO }, { red: false, videoOrder: ["video/VP8"] });
    expect(setCodecPreferences.mock.calls[1]![0][0].mimeType).toBe("video/VP8");
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
