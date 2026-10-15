import { describe, expect, it } from "vitest";
import { browserClass, DevicePermissions, type MediaKind, type PermState } from "./permissions.ts";
import { advanceAndSettle, FakeClock, settle } from "./testing/fake-clock.ts";
import { FakePermissions } from "./testing/fake-media.ts";

function setup(perms: FakePermissions | null = new FakePermissions("prompt", "prompt")) {
  const clock = new FakeClock();
  const changes: [MediaKind, PermState][] = [];
  const dp = new DevicePermissions({
    permissions: perms ?? undefined,
    clock,
    timeoutMs: 500,
    onChange: (k, s) => changes.push([k, s]),
  });
  return { clock, dp, perms, changes };
}

describe("DevicePermissions", () => {
  it("maps camera → video and microphone → audio", async () => {
    const { dp, perms } = setup(new FakePermissions("denied", "granted"));
    expect(await dp.query()).toEqual({ audio: "granted", video: "denied" });
    expect(perms!.queries.sort()).toEqual(["camera", "microphone"]);
    expect(dp.last).toEqual({ audio: "granted", video: "denied" });
  });

  it("no Permissions API → unknown, unsupported", async () => {
    const { dp } = setup(null);
    expect(dp.supported).toBe(false);
    expect(await dp.query()).toEqual({ audio: "unknown", video: "unknown" });
  });

  it("a name the browser rejects (Firefox 'camera') → unknown for that kind only", async () => {
    const { dp, perms } = setup(new FakePermissions("granted", "granted"));
    perms!.throws.add("camera");
    expect(await dp.query()).toEqual({ audio: "granted", video: "unknown" });
  });

  it("odd states → unknown", async () => {
    const { dp } = setup(new FakePermissions("weird", "prompt"));
    expect(await dp.query()).toEqual({ audio: "prompt", video: "unknown" });
  });

  it("a hanging query counts as unknown after the timeout", async () => {
    const { dp, perms, clock } = setup(new FakePermissions("granted", "granted"));
    perms!.gate = new Promise(() => {});
    const q = dp.query();
    await settle();
    await advanceAndSettle(clock, 500);
    expect(await q).toEqual({ audio: "unknown", video: "unknown" });
    expect(clock.pendingTimers).toBe(0);
  });

  it("relays change events once per status, updates `last`, and stops after close", async () => {
    const { dp, perms, changes } = setup();
    await dp.query();
    await dp.query(); // same status objects: still one listener each
    expect(perms!.status.camera.listenerCount).toBe(1);
    perms!.change("camera", "granted");
    expect(changes).toEqual([["video", "granted"]]);
    expect(dp.last.video).toBe("granted");
    dp.close();
    expect(perms!.status.camera.listenerCount).toBe(0);
    perms!.change("microphone", "granted");
    expect(changes).toHaveLength(1);
  });
});

describe("browserClass", () => {
  const cases: [string, string][] = [
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      "ios-safari",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1",
      "ios-chrome",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
      "android-chrome",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0 Mobile Safari/537.36",
      "android-samsung",
    ],
    [
      "Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 WhatsApp/2.24",
      "android-webview",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0",
      "desktop-firefox",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0",
      "desktop-edge",
    ],
    ["", "desktop-other"],
  ];
  it.each(cases)("%s → %s", (ua, want) => {
    expect(browserClass(ua)).toBe(want);
  });
});
