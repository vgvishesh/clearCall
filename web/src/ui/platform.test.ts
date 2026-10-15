import { describe, expect, it } from "vitest";
import {
  type BrowserClass,
  chromeIntentUrl,
  detectBrowser,
  isInApp,
  openInBrowserUrl,
  safariUrl,
} from "./platform.ts";

const IOS = (os: string, tail: string) =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS ${os} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${tail}`;
const ANDROID = (tail: string, wv = false) =>
  `Mozilla/5.0 (Linux; Android 14; Pixel 7${wv ? " Build/UQ1A.240205.004; wv" : ""}) AppleWebKit/537.36 (KHTML, like Gecko) ${tail}`;
const SAFARI_17 = IOS("17_5", "Version/17.5 Mobile/15E148 Safari/604.1");
const CHROME_ANDROID = ANDROID("Chrome/126.0.0.0 Mobile Safari/537.36");
const WV_TAIL = "Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36";

/** [label, UA, touch points, expected class, in-app app name]. Real-world UA shapes, trimmed. */
const TABLE: [string, string, number, BrowserClass, string | null][] = [
  ["iOS Safari", SAFARI_17, 5, "ios-safari", null],
  [
    "iPadOS Safari (desktop UA + touch)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    5,
    "ios-safari",
    null,
  ],
  ["iOS Chrome", IOS("17_5", "CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1"), 5, "ios-chrome", null],
  ["iOS Firefox", IOS("17_5", "FxiOS/127.0 Mobile/15E148 Safari/605.1.15"), 5, "ios-other", null],
  ["iOS Edge", IOS("17_5", "Version/17.0 EdgiOS/126.0 Mobile/15E148 Safari/605.1.15"), 5, "ios-other", null],
  ["Android Chrome", CHROME_ANDROID, 5, "android-chrome", null],
  [
    "Samsung Internet",
    "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
    5,
    "samsung",
    null,
  ],
  [
    "Xiaomi Mi Browser",
    "Mozilla/5.0 (Linux; U; Android 12; en-us; Redmi Note 11 Build/SKQ1.211103.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0.5615.136 Mobile Safari/537.36 XiaoMi/MiuiBrowser/14.6.0-gn",
    5,
    "miui",
    null,
  ],
  [
    "Firefox Android",
    "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
    5,
    "firefox-android",
    null,
  ],
  [
    "Instagram Android",
    ANDROID(`${WV_TAIL} Instagram 337.0.0.35.102 Android (34/14; 420dpi; 1080x2400)`, true),
    5,
    "in-app-android",
    "Instagram",
  ],
  [
    "Facebook Android",
    ANDROID(`${WV_TAIL} [FB_IAB/FB4A;FBAV/470.0.0.43.108;]`, true),
    5,
    "in-app-android",
    "Facebook",
  ],
  [
    "Messenger Android",
    ANDROID(`${WV_TAIL} [FB_IAB/Orca-Android;FBAV/460.0.0.48.109;]`, true),
    5,
    "in-app-android",
    "Messenger",
  ],
  [
    "Snapchat Android",
    ANDROID(`${WV_TAIL} Snapchat/13.0.0.40 (Pixel 7)`, true),
    5,
    "in-app-android",
    "Snapchat",
  ],
  ["LINE Android", ANDROID(`${WV_TAIL} Line/14.10.0/IAB`, true), 5, "in-app-android", "LINE"],
  ["WhatsApp / any Android WebView", ANDROID(WV_TAIL, true), 5, "in-app-android", null],
  ["Telegram (Custom Tab) is real Chrome", CHROME_ANDROID, 5, "android-chrome", null],
  [
    "Telegram WebView is not flagged",
    ANDROID(`${WV_TAIL} Telegram-Android/10.14.5`, true),
    5,
    "android-chrome",
    null,
  ],
  [
    "Instagram iOS",
    IOS("17_5", "Mobile/15E148 Instagram 337.0.3.23.54 (iPhone15,2; iOS 17_5; en_US)"),
    5,
    "in-app-ios",
    "Instagram",
  ],
  [
    "Facebook iOS",
    IOS("16_6", "Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.98;FBBV/600000000;FBDV/iPhone14,5]"),
    5,
    "in-app-ios",
    "Facebook",
  ],
  [
    "Messenger iOS",
    IOS("17_5", "Mobile/15E148 [FBAN/MessengerForiOS;FBAV/460.0]"),
    5,
    "in-app-ios",
    "Messenger",
  ],
  ["LINE iOS", IOS("17_5", "Mobile/15E148 Safari Line/14.10.0"), 5, "in-app-ios", "LINE"],
  [
    "Desktop Chrome",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    0,
    "desktop-chrome",
    null,
  ],
  [
    "Desktop Edge",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    0,
    "desktop-edge",
    null,
  ],
  [
    "Desktop Safari",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    0,
    "desktop-safari",
    null,
  ],
  [
    "Desktop Firefox",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0",
    0,
    "desktop-firefox",
    null,
  ],
  [
    "Facebook token on desktop is still desktop",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 FBAV/1",
    0,
    "desktop-chrome",
    null,
  ],
];

describe("detectBrowser", () => {
  it.each(TABLE)("%s", (_label, ua, touchPoints, cls, app) => {
    const b = detectBrowser(ua, { touchPoints, standalone: false });
    expect(b.cls).toBe(cls);
    expect(b.app).toBe(app);
  });

  it("home-screen app on iOS gets its own class", () => {
    expect(detectBrowser(SAFARI_17, { touchPoints: 5, standalone: true }).cls).toBe("ios-safari-standalone");
  });

  it("in-app beats the home-screen flag", () => {
    const ig = IOS("17_5", "Mobile/15E148 Instagram 337.0");
    expect(detectBrowser(ig, { touchPoints: 5, standalone: true }).cls).toBe("in-app-ios");
  });

  it("parses the iOS version", () => {
    expect(detectBrowser(SAFARI_17, { touchPoints: 5, standalone: false }).iosVersion).toBe(17);
    expect(detectBrowser(IOS("16_6", "Mobile/15E148 FBAN/FBIOS"), { touchPoints: 5 }).iosVersion).toBe(16);
    expect(detectBrowser(CHROME_ANDROID, { touchPoints: 5 }).iosVersion).toBeNull();
  });

  it("isInApp", () => {
    expect(isInApp("in-app-android")).toBe(true);
    expect(isInApp("in-app-ios")).toBe(true);
    expect(isInApp("android-chrome")).toBe(false);
  });
});

describe("open in another browser", () => {
  const link = "https://clearcall.app/c#Qm9uam91ciBjbGVhcmNhbGw";

  it("Chrome intent keeps the secret in the fragment, never in path or query", () => {
    const url = chromeIntentUrl(link);
    expect(url).toBe(
      "intent://clearcall.app/c#Qm9uam91ciBjbGVhcmNhbGw#Intent;scheme=https;package=com.android.chrome;" +
        "S.browser_fallback_url=https%3A%2F%2Fclearcall.app%2Fc%23Qm9uam91ciBjbGVhcmNhbGw;end",
    );
    // Intent.parseUri splits on the LAST '#': everything before it is the data URI, fragment included.
    const data = url.slice(0, url.lastIndexOf("#Intent;"));
    expect(data).toBe("intent://clearcall.app/c#Qm9uam91ciBjbGVhcmNhbGw");
    expect(url.endsWith(";end")).toBe(true);
    const beforeFragment = data.slice(0, data.indexOf("#"));
    expect(beforeFragment).not.toContain("Qm9uam91ciBjbGVhcmNhbGw");
    // The fallback is one percent-encoded parameter: no raw '#' or ';' that would break the intent.
    const fallback = url.slice(url.indexOf("S.browser_fallback_url=") + 23, -";end".length);
    expect(fallback).not.toMatch(/[#;]/);
    expect(decodeURIComponent(fallback)).toBe(link);
  });

  it("Chrome intent keeps an existing query (e.g. ?qa=1) and the port", () => {
    expect(chromeIntentUrl("https://localhost:8787/c?qa=1#abc")).toMatch(
      /^intent:\/\/localhost:8787\/c\?qa=1#abc#Intent;/,
    );
  });

  it("x-safari-https only on iOS 17+", () => {
    expect(safariUrl(link, 17)).toBe(`x-safari-${link}`);
    expect(safariUrl(link, 16)).toBeNull();
    expect(safariUrl(link, null)).toBeNull();
    expect(safariUrl("http://localhost/c#a", 17)).toBe("x-safari-http://localhost/c#a");
    expect(safariUrl("ftp://x/c#a", 17)).toBeNull();
    expect(chromeIntentUrl("http://localhost:8787/c#a")).toMatch(
      /^intent:\/\/localhost:8787\/c#a#Intent;scheme=http;/,
    );
  });

  it("openInBrowserUrl per platform", () => {
    const android = detectBrowser(ANDROID(WV_TAIL, true), { touchPoints: 5 });
    expect(openInBrowserUrl(link, android)).toMatch(/^intent:\/\//);
    const ios16 = detectBrowser(IOS("16_6", "Mobile/15E148 FBAN/FBIOS"), { touchPoints: 5 });
    expect(openInBrowserUrl(link, ios16)).toBeNull();
    const desktop = detectBrowser("Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36", {
      touchPoints: 0,
    });
    expect(openInBrowserUrl(link, desktop)).toBeNull();
  });
});
