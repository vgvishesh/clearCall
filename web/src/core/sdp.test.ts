import { describe, expect, it } from "vitest";
import {
  mLineKinds,
  mungeDescription,
  mungeOpusFmtp,
  mungeVideoFmtp,
  opusParamsFor,
  opusPayloadTypes,
  parseFmtp,
  readOpusFmtp,
  sdpOrigin,
  sdpSessionId,
  withVideoStartBitrate,
} from "./sdp.ts";
import { CHROME_OFFER, FIREFOX_OFFER, SAFARI_ANSWER_NO_FMTP } from "./testing/sdp-fixtures.ts";

const changedLines = (a: string, b: string) => {
  const al = a.split(/\r?\n/);
  const bl = b.split(/\r?\n/);
  return bl.filter((l, i) => al[i] !== l);
};

describe("sdp munging", () => {
  it("mode params", () => {
    expect(opusParamsFor("voice")).toEqual({ useinbandfec: 1, usedtx: 1, maxaveragebitrate: 128000 });
    // music negotiates stereo → libwebrtc Opus AUDIO application (W4 package A)
    expect(opusParamsFor("music")).toEqual({
      useinbandfec: 1,
      usedtx: 0,
      maxaveragebitrate: 128000,
      stereo: 1,
      "sprop-stereo": 1,
    });
  });

  it("Chrome: rewrites only the opus fmtp line, leaves RED and others alone, keeps CRLF", () => {
    const out = mungeOpusFmtp(CHROME_OFFER, opusParamsFor("voice"));
    expect(opusPayloadTypes(CHROME_OFFER)).toEqual(["111"]);
    expect(out).toContain("a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=128000\r\n");
    expect(out).toContain("a=fmtp:63 111/111\r\n");
    expect(out.split("\r\n").length).toBe(CHROME_OFFER.split("\r\n").length);
    expect(out.endsWith("\r\n")).toBe(true);
    expect(out.includes("\n") && !out.replace(/\r\n/g, "").includes("\n")).toBe(true);
    expect(changedLines(CHROME_OFFER, out)).toHaveLength(1);
  });

  it("Firefox: replaces existing keys in place and keeps stereo/maxplaybackrate", () => {
    const music = mungeOpusFmtp(FIREFOX_OFFER, opusParamsFor("music"));
    expect(readOpusFmtp(music)).toEqual({
      maxplaybackrate: "48000",
      stereo: "1",
      useinbandfec: "1",
      usedtx: "0",
      maxaveragebitrate: "128000",
      "sprop-stereo": "1",
    });
    expect(music).toContain("a=fmtp:101 0-15");
    expect(music).toContain("a=fmtp:126 profile-level-id=42e01f");
    // switching modes flips usedtx without duplicating keys
    const voice = mungeOpusFmtp(music, opusParamsFor("voice"));
    expect(readOpusFmtp(voice)?.usedtx).toBe("1");
    expect(voice.match(/usedtx/g)).toHaveLength(1);
  });

  it("Safari: inserts a missing fmtp line after the (uppercase) rtpmap, LF endings preserved", () => {
    const out = mungeOpusFmtp(SAFARI_ANSWER_NO_FMTP, opusParamsFor("voice"));
    const lines = out.split("\n");
    const i = lines.indexOf("a=rtpmap:111 OPUS/48000/2");
    expect(lines[i + 1]).toBe("a=fmtp:111 useinbandfec=1;usedtx=1;maxaveragebitrate=128000");
    expect(out.includes("\r")).toBe(false);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("is idempotent", () => {
    for (const sdp of [CHROME_OFFER, FIREFOX_OFFER, SAFARI_ANSWER_NO_FMTP]) {
      const once = mungeOpusFmtp(sdp, opusParamsFor("voice"));
      expect(mungeOpusFmtp(once, opusParamsFor("voice"))).toBe(once);
    }
  });

  it("handles opus in several audio sections", () => {
    const two = CHROME_OFFER.replace(
      "m=video",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\nm=video",
    );
    const out = mungeOpusFmtp(two, opusParamsFor("music"));
    expect(out.match(/a=fmtp:111 /g)).toHaveLength(2);
    expect(out.match(/usedtx=0/g)).toHaveLength(2);
  });

  it("passes through SDP without opus, empty SDP and rollback", () => {
    const noOpus = "v=0\r\nm=video 9 UDP 96\r\na=rtpmap:96 VP8/90000\r\n";
    expect(mungeOpusFmtp(noOpus, opusParamsFor("voice"))).toBe(noOpus);
    expect(mungeOpusFmtp("", opusParamsFor("voice"))).toBe("");
    const rb = { type: "rollback" as const };
    expect(mungeDescription(rb, "voice")).toBe(rb);
    expect(mungeDescription({ type: "offer", sdp: CHROME_OFFER }, "music").sdp).toContain("usedtx=0");
  });

  it("helpers", () => {
    expect(mLineKinds(CHROME_OFFER)).toEqual(["audio", "video", "application"]);
    expect(mLineKinds(FIREFOX_OFFER)).toEqual(["audio", "video", "application"]);
    expect(parseFmtp("a=1; b ;c=x=y")).toEqual([
      ["a", "1"],
      ["b", ""],
      ["c", "x=y"],
    ]);
    expect(readOpusFmtp("v=0\r\n")).toBeNull();
  });
});

describe("sdpSessionId", () => {
  it("reads the o= session id (Chrome, Firefox) and returns null when absent", () => {
    expect(sdpSessionId(CHROME_OFFER)).toBe("4611731400430051336");
    expect(sdpSessionId(FIREFOX_OFFER)).toBe("8520374405457046046");
    expect(sdpSessionId("v=0\r\ns=-\r\n")).toBeNull();
    expect(sdpSessionId(undefined)).toBeNull();
  });

  it("sdpOrigin returns the whole o= line (id + version)", () => {
    expect(sdpOrigin(CHROME_OFFER)).toBe("o=- 4611731400430051336 2 IN IP4 127.0.0.1");
    expect(sdpOrigin("v=0\r\n")).toBeNull();
  });
});

describe("video start bitrate munging", () => {
  const fmtpOf = (sdp: string, pt: string) =>
    sdp.split(/\r?\n/).find((l) => l.startsWith(`a=fmtp:${pt} `)) ?? null;

  it("adds x-google-start-bitrate to every real video codec, not rtx, and leaves audio alone", () => {
    const out = mungeVideoFmtp(CHROME_OFFER, { "x-google-start-bitrate": 1500 });
    expect(fmtpOf(out, "96")).toBe("a=fmtp:96 x-google-start-bitrate=1500"); // VP8 had no fmtp: added
    expect(fmtpOf(out, "98")).toBe("a=fmtp:98 profile-id=0;x-google-start-bitrate=1500"); // VP9 kept its params
    expect(fmtpOf(out, "97")).toBe("a=fmtp:97 apt=96"); // rtx untouched
    expect(readOpusFmtp(out)).toEqual(readOpusFmtp(CHROME_OFFER));
    expect(out.includes("\r\n")).toBe(CHROME_OFFER.includes("\r\n"));
  });

  it("replaces an existing value (idempotent) and handles Firefox/Safari shapes", () => {
    const once = mungeVideoFmtp(CHROME_OFFER, { "x-google-start-bitrate": 600 });
    expect(mungeVideoFmtp(once, { "x-google-start-bitrate": 600 })).toBe(once);
    const ff = mungeVideoFmtp(FIREFOX_OFFER, { "x-google-start-bitrate": 600 });
    expect(fmtpOf(ff, "126")).toContain("packetization-mode=1;x-google-start-bitrate=600");
    expect(fmtpOf(ff, "120")).toBe("a=fmtp:120 max-fs=12288;max-fr=60;x-google-start-bitrate=600");
    const sa = mungeVideoFmtp(SAFARI_ANSWER_NO_FMTP, { "x-google-start-bitrate": 600 });
    expect(fmtpOf(sa, "96")).toBe("a=fmtp:96 x-google-start-bitrate=600");
  });

  it("withVideoStartBitrate: null/0 and rollback pass through unchanged", () => {
    const offer = { type: "offer" as RTCSdpType, sdp: CHROME_OFFER };
    expect(withVideoStartBitrate(offer, null)).toBe(offer);
    expect(withVideoStartBitrate(offer, 0)).toBe(offer);
    const rb = { type: "rollback" as RTCSdpType };
    expect(withVideoStartBitrate(rb, 1500)).toBe(rb);
    expect(withVideoStartBitrate(offer, 1500).sdp).toContain("x-google-start-bitrate=1500");
    const both = withVideoStartBitrate(offer, 1500, 150).sdp!;
    expect(both).toContain("x-google-start-bitrate=1500;x-google-min-bitrate=150");
    expect(withVideoStartBitrate(offer, null, 150).sdp).toContain("x-google-min-bitrate=150");
  });
});
