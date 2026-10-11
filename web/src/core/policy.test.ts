import { describe, expect, it } from "vitest";
import {
  audioPolicy,
  mergeAudioEncoding,
  mergeVideoEncoding,
  rungFor,
  tierFor,
  videoPolicy,
  viewChanged,
  viewToReport,
} from "./policy.ts";

describe("tierFor (ADR-0005 table)", () => {
  it.each([
    [1, 720, 1_500_000, 30],
    [2, 720, 1_500_000, 30],
    [3, 360, 600_000, 30],
    [4, 360, 600_000, 30],
    [5, 180, 150_000, 15],
    [7, 180, 150_000, 15],
    [10, 180, 150_000, 15],
  ])("%i participants → %ip / %i bps / %i fps", (n, h, b, fps) => {
    expect(tierFor(n)).toEqual({ maxHeight: h, maxBitrate: b, maxFramerate: fps });
  });
});

describe("videoPolicy", () => {
  it("uses the tier when the receiver hasn't reported a view", () => {
    expect(videoPolicy({ participants: 2 })).toEqual({
      active: true,
      targetHeight: 720,
      maxBitrate: 1_500_000,
      maxFramerate: 30,
      scaleResolutionDownBy: 1,
    });
    expect(videoPolicy({ participants: 4, sourceShortSide: 720 })).toMatchObject({
      targetHeight: 360,
      maxBitrate: 600_000,
      scaleResolutionDownBy: 2,
    });
    expect(videoPolicy({ participants: 10, sourceShortSide: 720 })).toMatchObject({
      targetHeight: 180,
      maxBitrate: 150_000,
      maxFramerate: 15,
      scaleResolutionDownBy: 4,
    });
  });

  it("caps by the receiver's tile size, never above the tier", () => {
    // 2-party but the receiver shows us in a 300 device-px tile → 360p rung.
    expect(videoPolicy({ participants: 2, viewHeight: 300 })).toMatchObject({
      targetHeight: 360,
      maxBitrate: 600_000,
      scaleResolutionDownBy: 2,
    });
    // Tiny tile → lowest rung.
    expect(videoPolicy({ participants: 2, viewHeight: 90 })).toMatchObject({
      targetHeight: 180,
      maxBitrate: 250_000,
    });
    // Huge tile can't exceed tier for 3–4.
    expect(videoPolicy({ participants: 3, viewHeight: 2000 })).toMatchObject({
      targetHeight: 360,
      maxBitrate: 600_000,
    });
    // 5–10 tier bitrate wins over the 180p rung bitrate.
    expect(videoPolicy({ participants: 6, viewHeight: 180 }).maxBitrate).toBe(150_000);
  });

  it("pauses when the receiver doesn't render us", () => {
    expect(videoPolicy({ participants: 2, viewHeight: 0 }).active).toBe(false);
    expect(videoPolicy({ participants: 2, viewHeight: 1 }).active).toBe(true);
  });

  it("scales from the real capture size and never upscales", () => {
    expect(videoPolicy({ participants: 2, sourceShortSide: 480 }).scaleResolutionDownBy).toBe(1);
    expect(videoPolicy({ participants: 3, sourceShortSide: 1080 }).scaleResolutionDownBy).toBe(3);
    expect(
      videoPolicy({ participants: 2, viewHeight: 540, sourceShortSide: 720 }).scaleResolutionDownBy,
    ).toBe(1.33);
    expect(videoPolicy({ participants: 2, sourceShortSide: 0 }).scaleResolutionDownBy).toBe(1);
  });

  it("every participant count and view combination yields sane caps", () => {
    for (let n = 1; n <= 10; n++) {
      for (const v of [undefined, 0, 1, 120, 179, 180, 181, 360, 540, 719, 720, 1080, 4320]) {
        const c = videoPolicy({ participants: n, viewHeight: v });
        const t = tierFor(n);
        expect(c.targetHeight).toBeLessThanOrEqual(t.maxHeight);
        expect(c.maxBitrate).toBeLessThanOrEqual(t.maxBitrate);
        expect(c.maxBitrate).toBeGreaterThan(0);
        expect(c.scaleResolutionDownBy).toBeGreaterThanOrEqual(1);
        expect(c.maxFramerate).toBe(t.maxFramerate);
        expect(c.active).toBe(v !== 0);
      }
    }
  });
});

describe("audio + view helpers", () => {
  it("audio bitrate per mode", () => {
    expect(audioPolicy("voice").maxBitrate).toBe(32_000);
    expect(audioPolicy("music").maxBitrate).toBe(96_000);
  });

  it("hidden tab reports 0", () => {
    expect(viewToReport(360.4, false)).toBe(360);
    expect(viewToReport(360, true)).toBe(0);
    expect(viewToReport(Number.NaN, false)).toBe(0);
    expect(viewToReport(-5, false)).toBe(0);
    expect(viewToReport(99999, false)).toBe(4320);
  });

  it("view changes only matter across rungs or visibility", () => {
    expect(viewChanged(undefined, 300)).toBe(true);
    expect(viewChanged(300, 310)).toBe(false);
    expect(viewChanged(300, 400)).toBe(true);
    expect(viewChanged(300, 0)).toBe(true);
    expect(viewChanged(0, 0)).toBe(false);
    expect(viewChanged(0, 10)).toBe(true);
    expect(rungFor(5000).height).toBe(720);
  });
});

describe("encoding merges (read-modify-write)", () => {
  const caps = videoPolicy({ participants: 3 });

  it("keeps unrelated params and encodings length", () => {
    const params = {
      transactionId: "x",
      encodings: [{ rid: "a", priority: "high" as RTCPriorityType }, { rid: "b" }],
      codecs: [],
      headerExtensions: [],
      rtcp: {},
    } as unknown as RTCRtpSendParameters;
    const out = mergeVideoEncoding(params, caps)!;
    expect(out.transactionId).toBe("x");
    expect(out.encodings).toHaveLength(2);
    expect(out.encodings[0]).toMatchObject({ rid: "a", priority: "high", maxBitrate: 600_000, active: true });
    expect(out.encodings[1]).toEqual({ rid: "b" });
    expect(mergeVideoEncoding(out, caps)).toBeNull();
  });

  it("creates an encoding when the browser reports none", () => {
    const out = mergeVideoEncoding({ encodings: [] } as unknown as RTCRtpSendParameters, caps)!;
    expect(out.encodings).toHaveLength(1);
    const a = mergeAudioEncoding({ encodings: [{}] } as unknown as RTCRtpSendParameters, 32_000)!;
    expect(a.encodings[0]!.maxBitrate).toBe(32_000);
    expect(mergeAudioEncoding(a, 32_000)).toBeNull();
    expect(mergeAudioEncoding(a, 96_000)!.encodings[0]!.maxBitrate).toBe(96_000);
  });
});
