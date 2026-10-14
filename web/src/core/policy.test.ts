import { describe, expect, it } from "vitest";
import {
  audioPolicy,
  cpuCappedView,
  hasLevels,
  levelEligible,
  mergeAudioEncoding,
  mergeVideoEncoding,
  rungFor,
  TIER4_HIGH_BITRATE,
  tierFor,
  videoCeilingKbps,
  videoFloorKbps,
  videoPolicy,
  videoStartBitrateKbps,
  viewChanged,
  viewToReport,
  withoutDegradation,
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

describe("videoStartBitrateKbps", () => {
  it("starts at the tier cap", () => {
    expect(videoStartBitrateKbps(2)).toBe(tierFor(2).maxBitrate / 1000);
    expect(videoStartBitrateKbps(4)).toBe(tierFor(4).maxBitrate / 1000);
    expect(videoStartBitrateKbps(10)).toBe(tierFor(10).maxBitrate / 1000);
  });
  it("lab override wins; 0 = libwebrtc default (no munging)", () => {
    expect(videoStartBitrateKbps(2, 800)).toBe(800);
    expect(videoStartBitrateKbps(2, 0)).toBeNull();
  });
});

describe("3–4 tier send levels (ADR-0008)", () => {
  it("high raises the bitrate (600 → 800 kbps) and holds resolution, never changes the scale", () => {
    expect(TIER4_HIGH_BITRATE).toBe(800_000);
    for (const participants of [3, 4]) {
      const base = videoPolicy({ participants, sourceShortSide: 720 });
      const high = videoPolicy({ participants, sourceShortSide: 720, level: "high" });
      expect(base.maxBitrate).toBe(600_000);
      expect(base.degradationPreference).toBeUndefined();
      expect(high).toEqual({
        ...base,
        maxBitrate: TIER4_HIGH_BITRATE,
        degradationPreference: "maintain-resolution",
      });
    }
  });

  it("merge: high sets maintain-resolution; leaving high restores balanced; base never touches it", () => {
    const params = (dp?: string) =>
      ({
        transactionId: "t",
        encodings: [{ active: true, maxBitrate: 600_000, maxFramerate: 30, scaleResolutionDownBy: 2 }],
        ...(dp ? { degradationPreference: dp } : {}),
      }) as unknown as RTCRtpSendParameters;
    const base = videoPolicy({ participants: 3 });
    const high = videoPolicy({ participants: 3, level: "high" });
    expect(mergeVideoEncoding(params(), base)).toBeNull(); // base on a fresh sender: no call at all
    const up = mergeVideoEncoding(params(), high) as RTCRtpSendParameters & {
      degradationPreference?: string;
    };
    expect(up.degradationPreference).toBe("maintain-resolution");
    expect(up.encodings[0]).toMatchObject({ maxBitrate: 800_000, scaleResolutionDownBy: 2 });
    const down = mergeVideoEncoding(
      { ...params("maintain-resolution"), encodings: [{ ...up.encodings[0]! }] } as RTCRtpSendParameters,
      base,
    ) as RTCRtpSendParameters & { degradationPreference?: string };
    expect(down.degradationPreference).toBe("balanced");
    expect(down.encodings[0]!.maxBitrate).toBe(600_000);
    // fallback for engines that reject it: same encodings, preference as it was
    const plain = withoutDegradation(up, params()) as RTCRtpSendParameters & {
      degradationPreference?: string;
    };
    expect("degradationPreference" in plain).toBe(false);
    expect(plain.encodings[0]!.maxBitrate).toBe(800_000);
  });

  it("high applies only when the receiver's tile wants the full 360p", () => {
    expect(videoPolicy({ participants: 3, viewHeight: 1200, level: "high" }).maxBitrate).toBe(800_000);
    expect(videoPolicy({ participants: 3, viewHeight: 300, level: "high" }).maxBitrate).toBe(800_000);
    expect(videoPolicy({ participants: 3, viewHeight: 250, level: "high" }).maxBitrate).toBe(400_000);
    expect(levelEligible(3, 270)).toBe(false);
    expect(levelEligible(4, 360)).toBe(true);
  });

  it("2-party and 5–10 tiers ignore the level", () => {
    expect(videoPolicy({ participants: 2, level: "high" })).toEqual(videoPolicy({ participants: 2 }));
    expect(videoPolicy({ participants: 2, viewHeight: 300, level: "high" }).maxBitrate).toBe(600_000);
    expect(videoPolicy({ participants: 6, level: "high" })).toEqual(videoPolicy({ participants: 6 }));
    expect([1, 2, 5, 10].map(hasLevels)).toEqual([false, false, false, false]);
    expect([3, 4].map(hasLevels)).toEqual([true, true]);
  });

  it("start bitrate stays at the base cap", () => {
    expect(videoStartBitrateKbps(3)).toBe(600);
  });
});

describe("videoFloorKbps (ADR-0009)", () => {
  it("floors only 2-party calls; ?vmin= overrides, 0 disables", () => {
    expect(videoFloorKbps(1)).toBe(200);
    expect(videoFloorKbps(2)).toBe(200);
    expect(videoFloorKbps(3)).toBeNull();
    expect(videoFloorKbps(10)).toBeNull();
    expect(videoFloorKbps(3, 150)).toBe(150);
    expect(videoFloorKbps(2, 0)).toBeNull();
  });
  it("ceiling = highest tier cap × 1.2 + voice audio; ?vmax= overrides, 0 disables", () => {
    expect(videoCeilingKbps(2)).toBe(1832);
    expect(videoCeilingKbps(3)).toBe(992); // 3–4 high level 800 kbps, above the 915 kbps upgrade bar
    expect(videoCeilingKbps(6)).toBe(212);
    expect(videoCeilingKbps(2, 1600)).toBe(1600);
    expect(videoCeilingKbps(2, 0)).toBeNull();
  });
});

describe("CPU guard levels (ADR-0010)", () => {
  it("reduced = ≤ 360p at 15 fps and the 360p bitrate; paused = inactive", () => {
    const r = videoPolicy({ participants: 2, viewHeight: 1080, sourceShortSide: 720, cpuLevel: 1 });
    expect(r).toMatchObject({
      active: true,
      targetHeight: 360,
      maxFramerate: 15,
      maxBitrate: 600_000,
      scaleResolutionDownBy: 2,
    });
    expect(videoPolicy({ participants: 2, viewHeight: 1080, cpuLevel: 2 }).active).toBe(false);
    expect(videoPolicy({ participants: 2, viewHeight: 1080, cpuLevel: 0 }).targetHeight).toBe(720);
    // 5–10 tier already below the reduced caps: unchanged except nothing.
    expect(videoPolicy({ participants: 6, viewHeight: 180, cpuLevel: 1 })).toMatchObject({
      targetHeight: 180,
      maxFramerate: 15,
    });
  });

  it("caps the view we report", () => {
    expect(cpuCappedView(1080, 0)).toBe(1080);
    expect(cpuCappedView(1080, 1)).toBe(360);
    expect(cpuCappedView(240, 1)).toBe(240);
    expect(cpuCappedView(1080, 2)).toBe(0);
    expect(cpuCappedView(0, 1)).toBe(0);
  });
});
