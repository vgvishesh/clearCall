import { describe, expect, it } from "vitest";
import { SpeakerTracker } from "./active-speaker.ts";
import { qualityFrom, StatsSampler, summarizePeerStats } from "./stats.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import type { QaPeerStats } from "./types.ts";

function chromeReport(scale = 1): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  const add = (o: Record<string, unknown>) => m.set(o.id as string, o);
  add({ id: "T01", type: "transport", selectedCandidatePairId: "CP1" });
  add({
    id: "CP1",
    type: "candidate-pair",
    localCandidateId: "L1",
    currentRoundTripTime: 0.123,
    availableOutgoingBitrate: 2_000_000,
  });
  add({ id: "CP2", type: "candidate-pair", localCandidateId: "L2", currentRoundTripTime: 0.9 });
  add({ id: "L1", type: "local-candidate", candidateType: "relay" });
  add({ id: "COpus", type: "codec", mimeType: "audio/opus" });
  add({ id: "CVP9", type: "codec", mimeType: "video/VP9" });
  add({
    id: "IA",
    type: "inbound-rtp",
    kind: "audio",
    codecId: "COpus",
    bytesReceived: 4000 * scale,
    packetsReceived: 100 * scale,
    packetsLost: 0,
    jitter: 0.004,
    audioLevel: 0.2,
    concealedSamples: 10,
    totalSamplesReceived: 48000 * scale,
  });
  add({
    id: "IV",
    type: "inbound-rtp",
    kind: "video",
    codecId: "CVP9",
    bytesReceived: 100_000 * scale,
    packetsReceived: 200 * scale,
    packetsLost: 4 * scale,
    framesDecoded: 30 * scale,
    totalDecodeTime: 0.06 * scale,
    framesDropped: 0,
    freezeCount: 1,
    totalFreezesDuration: 0.3,
    frameHeight: 720,
    framesPerSecond: 30,
    jitterBufferDelay: 1.5,
    jitterBufferEmittedCount: 30,
  });
  add({ id: "OA", type: "outbound-rtp", kind: "audio", bytesSent: 4000 * scale });
  add({
    id: "OV",
    type: "outbound-rtp",
    kind: "video",
    codecId: "CVP9",
    bytesSent: 150_000 * scale,
    frameHeight: 360,
    framesEncoded: 30 * scale,
    totalEncodeTime: 0.15 * scale,
    qualityLimitationReason: "bandwidth",
  });
  add({ id: "RIV", type: "remote-inbound-rtp", kind: "video", fractionLost: 0.0625 });
  return m;
}

describe("summarizePeerStats", () => {
  it("maps a Chrome-like report incl. selected pair, codecs and per-frame costs", () => {
    const { stats, quality } = summarizePeerStats(
      chromeReport(),
      { id: "p", name: "Ann", connectionState: "connected" },
      1000,
    );
    expect(stats).toMatchObject({
      id: "p",
      candidateType: "relay",
      rttMs: 123,
      availableOutgoingBitrate: 2_000_000,
      audio: { bytesReceived: 4000, bytesSent: 4000, jitter: 0.004, audioLevel: 0.2, codec: "opus" },
      video: {
        framesDecoded: 30,
        freezeCount: 1,
        frameHeight: 720,
        sentFrameHeight: 360,
        qualityLimitationReason: "bandwidth",
        remoteFractionLost: 0.0625,
        decodeMsPerFrame: 2,
        encodeMsPerFrame: 5,
        jitterBufferMs: 50,
        codec: "VP9",
      },
    });
    expect(stats.inboundKbps).toBeUndefined();
    expect(quality).toBe("good");
  });

  it("computes kbps, interval loss and interval encode cost from the previous sample", () => {
    const first = summarizePeerStats(
      chromeReport(1),
      { id: "p", name: "", connectionState: "connected" },
      1000,
    );
    const second = summarizePeerStats(
      chromeReport(2),
      { id: "p", name: "", connectionState: "connected" },
      2000,
      first.raw,
    );
    // in: 104000 bytes/s → 832 kbps; out: 154000 bytes/s → 1232 kbps
    expect(second.stats.inboundKbps).toBe(832);
    expect(second.stats.outboundKbps).toBe(1232);
    // loss: 4 lost / (4 + 300) ≈ 1.3 % → good
    expect(second.quality).toBe("good");
    expect(second.stats.video.encodeMsPerFrame).toBe(5);
  });

  it("never throws on sparse (Safari/Firefox-like) reports; missing fields are undefined", () => {
    const sparse = new Map<string, Record<string, unknown>>([
      ["x", { id: "x", type: "inbound-rtp", mediaType: "video", bytesReceived: 10 }],
      [
        "cp",
        { id: "cp", type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.3 },
      ],
    ]);
    const { stats, quality } = summarizePeerStats(sparse, { id: "p", name: "", connectionState: "new" }, 0);
    expect(stats.video.bytesReceived).toBe(10);
    expect(stats.video.freezeCount).toBeUndefined();
    expect(stats.video.jitterBufferMs).toBeUndefined();
    expect(stats.candidateType).toBeUndefined();
    expect(stats.rttMs).toBe(300);
    expect(quality).toBe("fair");
    expect(summarizePeerStats(new Map(), { id: "p", name: "", connectionState: "new" }, 0).quality).toBe(
      "unknown",
    );
  });

  it("quality badge thresholds", () => {
    expect(qualityFrom(199, 0.019)).toBe("good");
    expect(qualityFrom(200, 0)).toBe("fair");
    expect(qualityFrom(100, 0.05)).toBe("fair");
    expect(qualityFrom(399, 0.059)).toBe("fair");
    expect(qualityFrom(400, 0)).toBe("poor");
    expect(qualityFrom(50, 0.1)).toBe("poor");
    expect(qualityFrom(undefined, undefined)).toBe("unknown");
  });
});

describe("StatsSampler", () => {
  const peer = (id: string, o: Partial<QaPeerStats> = {}): QaPeerStats => ({
    id,
    name: "",
    connectionState: "connected",
    audio: {},
    video: { encodeMsPerFrame: id === "a" ? 4 : 6 },
    inboundKbps: 100,
    outboundKbps: 200,
    ...o,
  });

  it("samples at 1 Hz into a bounded ring with local aggregates", async () => {
    const clock = new FakeClock(0);
    const samples: number[] = [];
    const s = new StatsSampler({
      clock,
      capacity: 3,
      collect: async () => [peer("a"), peer("b")],
      performance: { memory: { usedJSHeapSize: 50 * 1048576 } },
      onSample: (x) => samples.push(x.t),
    });
    s.start();
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      await new Promise((r) => setTimeout(r, 0));
    }
    s.stop();
    expect(samples).toEqual([1000, 2000, 3000, 4000, 5000]);
    const tl = s.timeline();
    expect(tl.map((x) => x.t)).toEqual([3000, 4000, 5000]);
    expect(tl[0]!.local).toEqual({ encodeMsPerFrame: 5, outboundKbps: 400, inboundKbps: 200, heapMb: 50 });
    expect(tl[0]!.peers).toHaveLength(2);
  });

  it("survives collector failures", async () => {
    const s = new StatsSampler({
      clock: new FakeClock(),
      collect: async () => {
        throw new Error("boom");
      },
    });
    expect(await s.tick()).toBeNull();
    expect(s.timeline()).toEqual([]);
  });
});

describe("SpeakerTracker (active speaker hysteresis)", () => {
  const L = (o: Record<string, number>) => new Map(Object.entries(o));

  it("picks the first speaker immediately and holds it ≥ 1.5 s", () => {
    const t = new SpeakerTracker();
    expect(t.update(L({ a: 0, b: 0 }), 0).activeId).toBeNull();
    expect(t.update(L({ a: 0.3, b: 0 }), 100).activeId).toBe("a");
    // b gets much louder and a goes quiet, but the hold keeps a
    let snap = t.update(L({ a: 0, b: 0.6 }), 400);
    expect(snap.activeId).toBe("a");
    expect(snap.speaking.has("b")).toBe(true);
    snap = t.update(L({ a: 0, b: 0.6 }), 1500);
    expect(snap.activeId).toBe("a");
    snap = t.update(L({ a: 0, b: 0.6 }), 1700);
    expect(snap.activeId).toBe("b");
  });

  it("does not switch while the current speaker keeps talking at a similar level", () => {
    const t = new SpeakerTracker();
    t.update(L({ a: 0.3, b: 0 }), 0);
    for (let now = 200; now <= 6000; now += 200) {
      const s = t.update(L({ a: 0.3, b: 0.35 }), now);
      expect(s.activeId).toBe("a");
    }
    // b clearly dominates (× > 1.5) → switch after hold
    expect(t.update(L({ a: 0.1, b: 0.6 }), 6200).activeId).toBe("b");
  });

  it("keeps the last speaker through silence, clears it when they leave", () => {
    const t = new SpeakerTracker();
    t.update(L({ a: 0.5 }), 0);
    let s = t.update(L({ a: 0 }), 200);
    for (let now = 400; now <= 10_000; now += 200) s = t.update(L({ a: 0 }), now);
    expect(s.activeId).toBe("a");
    expect(s.speaking.size).toBe(0);
    expect(t.update(L({ b: 0 }), 10_200).activeId).toBeNull();
  });

  it("speaking has a release tail and levels are smoothed (fast attack, slow release)", () => {
    const t = new SpeakerTracker({ releaseMs: 600 });
    t.update(L({ a: 0.5 }), 0);
    const s1 = t.update(L({ a: 0 }), 200);
    expect(s1.speaking.has("a")).toBe(true);
    expect(s1.levels.get("a")).toBeCloseTo(0.3);
    let last = t.update(L({ a: 0 }), 400);
    for (let now = 600; now <= 2000; now += 200) last = t.update(L({ a: 0 }), now);
    expect(last.speaking.has("a")).toBe(false);
    expect(t.update(L({ a: Number.NaN }), 2200).levels.get("a")).toBeLessThan(0.01);
  });
});
