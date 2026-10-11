import { describe, expect, it } from "vitest";
import { shouldContain } from "./Video.tsx";

const phonePortrait = 393 / 659;
const desktop = 1440 / 900;

describe("shouldContain", () => {
  it("never letterboxes before the video size is known", () => {
    expect(shouldContain(0, phonePortrait, true)).toBe(false);
    expect(shouldContain(16 / 9, undefined, true)).toBe(false);
  });

  it("letterboxes a portrait phone video in a landscape box (any tile)", () => {
    expect(shouldContain(9 / 16, desktop)).toBe(true);
  });

  it("letterboxes a laptop's 16:9 video full-bleed on a portrait phone", () => {
    expect(shouldContain(16 / 9, phonePortrait, true)).toBe(true);
  });

  it("crops small mismatches and small tiles", () => {
    expect(shouldContain(16 / 9, desktop, true)).toBe(false);
    expect(shouldContain(4 / 3, 1, true)).toBe(false);
    // A 4:3 sender still fills a portrait phone (crop ~2.2x).
    expect(shouldContain(4 / 3, phonePortrait, true)).toBe(false);
    // Grid tiles and the self PiP keep filling their box.
    expect(shouldContain(16 / 9, phonePortrait, false)).toBe(false);
  });
});
