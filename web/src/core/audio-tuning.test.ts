import { describe, expect, it } from "vitest";
import { audioTuningFrom } from "./deps.ts";
import { audioConstraints } from "./media.ts";
import { AUDIO_BITRATE, audioPolicy } from "./policy.ts";
import { mungeDescription, opusParamsFor, readOpusFmtp } from "./sdp.ts";

const SDP = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "",
].join("\r\n");

describe("audio tuning flags (lab overrides)", () => {
  it("parses only valid keys", () => {
    expect(audioTuningFrom(new URLSearchParams(""))).toBeUndefined();
    expect(audioTuningFrom(new URLSearchParams("red=1&qa=1"))).toBeUndefined();
    expect(audioTuningFrom(new URLSearchParams("abr=40000&mabr=128000&ns=0&agc=1&dtx=0&fec=0"))).toEqual({
      voiceBitrate: 40_000,
      musicBitrate: 128_000,
      ns: false,
      agc: true,
      dtx: false,
      fec: false,
    });
    // out of Opus range / not a number / not 0|1 → ignored
    expect(audioTuningFrom(new URLSearchParams("abr=100&mabr=abc&ns=yes"))).toBeUndefined();
  });

  it("defaults are unchanged without tuning", () => {
    expect(opusParamsFor("voice")).toEqual({ useinbandfec: 1, usedtx: 1, maxaveragebitrate: 128_000 });
    expect(opusParamsFor("music")).toEqual({
      useinbandfec: 1,
      usedtx: 0,
      maxaveragebitrate: 128_000,
      stereo: 1,
      "sprop-stereo": 1,
    });
    expect(audioConstraints("voice")).toMatchObject({ noiseSuppression: true, autoGainControl: true });
    expect(audioPolicy("voice")).toEqual({ maxBitrate: AUDIO_BITRATE.voice });
    expect(audioPolicy("music")).toEqual({ maxBitrate: AUDIO_BITRATE.music });
  });

  it("applies DTX/FEC overrides to the fmtp", () => {
    const out = mungeDescription({ type: "offer" as RTCSdpType, sdp: SDP }, "voice", {
      dtx: false,
      fec: false,
    });
    expect(readOpusFmtp(out.sdp!)).toMatchObject({ usedtx: "0", useinbandfec: "0", minptime: "10" });
    // DTX can never be switched on in music mode
    expect(opusParamsFor("music", { dtx: true }).usedtx).toBe(0);
  });

  it("negotiates stereo (Opus AUDIO application) in music mode by default, never in voice", () => {
    expect(audioTuningFrom(new URLSearchParams("mstereo=1"))).toEqual({ musicStereo: true });
    const music = mungeDescription({ type: "answer" as RTCSdpType, sdp: SDP }, "music", {
      musicStereo: true,
    });
    expect(readOpusFmtp(music.sdp!)).toMatchObject({ stereo: "1", "sprop-stereo": "1", usedtx: "0" });
    expect(opusParamsFor("voice", { musicStereo: true })).not.toHaveProperty("stereo");
    expect(opusParamsFor("music")).toMatchObject({ stereo: 1, "sprop-stereo": 1, usedtx: 0 });
    expect(opusParamsFor("music", { musicStereo: false })).not.toHaveProperty("stereo");
    expect(opusParamsFor("voice")).not.toHaveProperty("stereo");
  });

  it("ec=0 turns echo cancellation off in both modes (lab diagnostic)", () => {
    expect(audioTuningFrom(new URLSearchParams("ec=0"))).toEqual({ ec: false });
    expect(audioConstraints("voice", { ec: false }).echoCancellation).toBe(false);
    expect(audioConstraints("music", { ec: false }).echoCancellation).toBe(false);
    expect(audioConstraints("music").echoCancellation).toBe(true);
  });

  it("applies NS/AGC overrides to voice capture only", () => {
    expect(audioConstraints("voice", { ns: false, agc: false })).toMatchObject({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(audioConstraints("music", { ns: true, agc: true })).toMatchObject({
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it("applies per-mode bitrate overrides", () => {
    expect(audioPolicy("voice", { voiceBitrate: 40_000, musicBitrate: 64_000 })).toEqual({
      maxBitrate: 40_000,
    });
    expect(audioPolicy("music", { voiceBitrate: 40_000, musicBitrate: 64_000 })).toEqual({
      maxBitrate: 64_000,
    });
    expect(audioPolicy("music", { voiceBitrate: 40_000 })).toEqual({ maxBitrate: AUDIO_BITRATE.music });
  });
});
