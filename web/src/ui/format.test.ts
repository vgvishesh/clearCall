import { describe, expect, it } from "vitest";
import { deviceHelp, endedReason, errorCopy } from "./copy.ts";
import { describeDuration, displayName, formatDuration, initialOf } from "./format.ts";
import { detectPlatform, isIosSafari } from "./platform.ts";

describe("format", () => {
  it("formatDuration", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
    expect(formatDuration(7_400)).toBe("0:07");
    expect(formatDuration(754_000)).toBe("12:34");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });

  it("describeDuration", () => {
    expect(describeDuration(0)).toBe("0 seconds");
    expect(describeDuration(61_000)).toBe("1 minute 1 second");
    expect(describeDuration(3_600_000)).toBe("1 hour");
  });

  it("names and initials", () => {
    expect(displayName("  ")).toBe("Guest");
    expect(displayName("Maya")).toBe("Maya");
    expect(initialOf("maya")).toBe("M");
    expect(initialOf("")).toBe("G");
    expect(initialOf("élodie")).toBe("É");
  });
});

describe("copy", () => {
  it("every error code has a title, body and sane actions", () => {
    for (const code of [
      "room-full",
      "invalid-link",
      "unsupported",
      "signaling-unavailable",
      "version-mismatch",
      "app-failed",
    ] as const) {
      const c = errorCopy(code);
      expect(c.title.length).toBeGreaterThan(5);
      expect(c.body.length).toBeGreaterThan(10);
      expect(c.actions.length).toBeLessThanOrEqual(2);
    }
    expect(errorCopy("version-mismatch").actions).toEqual(["reload"]);
  });

  it("device help is platform specific", () => {
    expect(deviceHelp("permission-denied", false, true, "ios").steps).toMatch(/Settings › Safari/);
    expect(deviceHelp("permission-denied", false, true, "android").steps).toMatch(/lock icon/);
    expect(deviceHelp("permission-denied", false, false, "desktop").title).toBe(
      "Camera and microphone are blocked",
    );
    expect(deviceHelp("no-devices", false, true, "ios").title).toBe("No camera available");
  });

  it("ended reasons", () => {
    expect(endedReason(undefined)).toBeNull();
    expect(endedReason("signaling-unavailable")).toMatch(/lost/);
  });
});

describe("platform", () => {
  const iphone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  it("detects iOS Safari only", () => {
    expect(detectPlatform(iphone, 5)).toBe("ios");
    expect(isIosSafari(iphone, 5)).toBe(true);
    expect(isIosSafari(iphone.replace("Version/17.0", "CriOS/120.0"), 5)).toBe(false);
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 7)", 5)).toBe("android");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe("desktop");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("ios");
  });
});
