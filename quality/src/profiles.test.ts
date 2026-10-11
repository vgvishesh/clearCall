import { describe, expect, it } from "vitest";
import { changePoints, linkAt, listProfiles, loadProfile, ProfileError, parseProfile } from "./profiles.ts";

describe("parseProfile", () => {
  it("parses every shipped profile", () => {
    const names = listProfiles();
    expect(names).toContain("good_wifi");
    for (const n of names) expect(() => loadProfile(n), n).not.toThrow();
  });

  it("maps fields and corpus", () => {
    const p = loadProfile("3g_lossy");
    expect(p.link).toEqual({
      up_kbps: 400,
      down_kbps: 1000,
      delay_ms: 150,
      jitter_ms: 40,
      loss_pct: 5,
      loss_model: "gilbert",
    });
    expect(p).toMatchObject({
      topology: "p2p",
      participants: 2,
      audio: "speech_noisy",
      video: "talking_head",
    });
  });

  it("mesh participants and music defaults", () => {
    expect(loadProfile("group_10").participants).toBe(10);
    const m = loadProfile("music_mode");
    expect(m.mode).toBe("music");
    expect(m.audio).toBe("music");
    expect(m.video).toBe("talking_head");
  });

  it("takes base values from a schedule step at 0 (bw_squeeze)", () => {
    const p = loadProfile("bw_squeeze");
    expect(p.link.up_kbps).toBe(2000);
    expect(linkAt(p, 0).up_kbps).toBe(2000);
    expect(linkAt(p, 29.9).up_kbps).toBe(2000);
    expect(linkAt(p, 30).up_kbps).toBe(250);
    expect(linkAt(p, 59).up_kbps).toBe(250);
    expect(linkAt(p, 75).up_kbps).toBe(2000);
    expect(linkAt(p, 45).delay_ms).toBe(40); // untouched fields persist
    expect(changePoints(p)).toEqual([30, 60]);
  });

  it("rejects invalid profiles with a useful message", () => {
    const bad = [
      ["link: { down_kbps: 1 }", /up_kbps is required/],
      ["link: { up_kbps: -1, down_kbps: 1 }", /up_kbps must be a number/],
      ["link: { up_kbps: 1, down_kbps: 1, loss_pct: 101 }", /loss_pct/],
      ["link: { up_kbps: 1, down_kbps: 1, loss_model: burst }", /loss_model/],
      ["link: { up_kbps: 1, down_kbps: 1 }\ntopology: star", /topology/],
      ["link: { up_kbps: 1, down_kbps: 1 }\ntopology: mesh\nparticipants: 11", /participants/],
      ["link: { up_kbps: 1, down_kbps: 1 }\nparticipants: 3", /exactly 2/],
      ["link: { up_kbps: 1, down_kbps: 1 }\ncorpus: [podcast]", /unknown corpus/],
      ["link: { up_kbps: 1, down_kbps: 1 }\ncorpus: [music, speech_clean]", /at most one audio/],
      ["link: { up_kbps: 1, down_kbps: 1, schedule: 3 }", /schedule must be a list/],
      ["", /empty profile/],
    ] as const;
    for (const [yaml, msg] of bad) {
      expect(() => parseProfile("x", yaml), yaml).toThrow(ProfileError);
      expect(() => parseProfile("x", yaml), yaml).toThrow(msg);
    }
  });

  it("applies defaults", () => {
    const p = parseProfile("x", "link: { up_kbps: 100, down_kbps: 200 }");
    expect(p).toMatchObject({
      topology: "p2p",
      participants: 2,
      duration_s: 60,
      audio: "speech_clean",
      video: "talking_head",
      mode: "voice",
      seed: 1,
      schedule: [],
    });
    expect(p.link).toMatchObject({ delay_ms: 0, jitter_ms: 0, loss_pct: 0, loss_model: "random" });
  });
});
