import { describe, expect, it } from "vitest";
import {
  askingCopy,
  BLOCKED_STEPS,
  boldParts,
  deviceHelp,
  endedReason,
  errorCopy,
  inAppCopy,
  joinLabel,
  primeCopy,
  promptLook,
  troubleCopy,
} from "./copy.ts";
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

  it("device help is browser specific: three steps each, no jargon", () => {
    expect(deviceHelp("permission-denied", false, true, "ios-safari").steps[0]!.text).toMatch(/aA/);
    expect(deviceHelp("permission-denied", false, true, "ios-safari-standalone").steps[1]!.text).toMatch(
      /Safari/,
    );
    expect(deviceHelp("permission-denied", false, true, "android-chrome").steps[0]!.text).toMatch(
      /web address/,
    );
    expect(deviceHelp("permission-denied", false, false, "desktop-chrome").title).toBe(
      "Your camera and mic are blocked",
    );
    expect(deviceHelp("permission-denied", false, true, "desktop-chrome").title).toBe(
      "Your camera is blocked",
    );
    expect(deviceHelp("no-devices", false, true, "ios-safari").title).toBe("No camera found");
    expect(deviceHelp("no-devices", false, true, "ios-safari").steps).toEqual([]);
    for (const [cls, steps] of Object.entries(BLOCKED_STEPS)) {
      expect(steps, cls).toHaveLength(3);
      // Jargon only where it is the literal on-screen label (in **bold**).
      for (const s of steps)
        expect(s.text.replace(/\*\*[^*]+\*\*/g, ""), cls).not.toMatch(/permission|WebRTC|browser settings/i);
    }
  });

  it("coach copy", () => {
    const ios = { cls: "ios-safari", platform: "ios", iosVersion: 17, app: null } as const;
    expect(primeCopy("ios").title).toMatch(/phone will ask/);
    expect(primeCopy("desktop").text).toBe("Click **Allow**.");
    expect(askingCopy(ios).title).toBe("Tap **Allow**");
    expect(askingCopy(ios).text).toMatch(/middle/);
    expect(troubleCopy({ ...ios, cls: "in-app-ios", app: "Instagram" }).text).toMatch(/Safari/);
    expect(inAppCopy({ ...ios, cls: "in-app-ios", app: "Instagram" }, false).text).toMatch(/Open in Safari/);
    expect(promptLook("samsung").where).toBe("bottom");
    expect(boldParts("Tap **Allow**.")).toEqual([
      { text: "Tap ", bold: false },
      { text: "Allow", bold: true },
      { text: ".", bold: false },
    ]);
  });

  it("join label says what you join with", () => {
    expect(joinLabel({ joining: false, cam: false, mic: false })).toBe("Join and just listen");
    expect(joinLabel({ joining: false, cam: false, mic: true })).toBe("Join with sound only");
    expect(joinLabel({ joining: false, cam: true, mic: true })).toBe("Join call");
    expect(joinLabel({ joining: true, cam: true, mic: true })).toBe("Joining…");
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
