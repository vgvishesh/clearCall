/** Platform sniffing for copy and hints only (never for capability decisions — the controller owns those). */

export type Platform = "ios" | "android" | "desktop";

export function detectPlatform(
  ua: string = navigator.userAgent,
  touchPoints = navigator.maxTouchPoints,
): Platform {
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  // iPadOS reports a Mac UA; touch support gives it away.
  if (/Macintosh/.test(ua) && touchPoints > 1) return "ios";
  if (/Android/.test(ua)) return "android";
  return "desktop";
}

/** Safari on iOS (not Chrome/Firefox/Edge for iOS, which can't add to the Home Screen the same way). */
export function isIosSafari(
  ua: string = navigator.userAgent,
  touchPoints = navigator.maxTouchPoints,
): boolean {
  return (
    detectPlatform(ua, touchPoints) === "ios" && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
  );
}

/**
 * Which browser the page runs in — for the permission coach's pictures and steps only (ADR-0011). Telemetry may log
 * the class, never the UA string. In-app browsers (WebViews inside WhatsApp, Instagram, …) win over everything:
 * they get "Open in Chrome / Safari", never lock-icon steps.
 */
export type BrowserClass =
  | "ios-safari"
  | "ios-safari-standalone"
  | "ios-chrome"
  | "ios-other"
  | "android-chrome"
  | "samsung"
  | "miui"
  | "firefox-android"
  | "in-app-android"
  | "in-app-ios"
  | "desktop-chrome"
  | "desktop-edge"
  | "desktop-safari"
  | "desktop-firefox";

export interface BrowserInfo {
  cls: BrowserClass;
  platform: Platform;
  /** Major iOS/iPadOS version; null elsewhere or when unknown. */
  iosVersion: number | null;
  /** The app hosting an in-app browser ("WhatsApp"), when known. */
  app: string | null;
}

interface Rule {
  re: RegExp;
}
interface InAppRule extends Rule {
  app: string;
}
interface ClassRule extends Rule {
  cls: BrowserClass;
}

/** Apps whose links open in their own WebView. Order matters (Messenger before Facebook). Keep small: UA lists drift. */
export const IN_APP_RULES: InAppRule[] = [
  { app: "Messenger", re: /FBAN\/Messenger|MessengerForiOS|FB_IAB\/MESSENGER|Orca-Android/ },
  { app: "Facebook", re: /FBAN|FBAV|FB_IAB|FBIOS/ },
  { app: "Instagram", re: /Instagram/ },
  { app: "WhatsApp", re: /WhatsApp/ },
  { app: "Snapchat", re: /Snapchat/ },
  { app: "LINE", re: /\bLine\// },
  { app: "TikTok", re: /musical_ly|BytedanceWebview|TikTok/ },
  { app: "WeChat", re: /MicroMessenger/ },
];

/** Android System WebView marker (any app's embedded browser). */
const ANDROID_WEBVIEW = /; wv\)/;
/** Telegram / LinkedIn open links in Custom Tabs (a real Chrome tab): never flagged as in-app. */
const NOT_IN_APP = /Telegram|LinkedInApp/;

const IOS_RULES: ClassRule[] = [
  { cls: "ios-chrome", re: /CriOS\// },
  { cls: "ios-other", re: /FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|YaBrowser|GSA\/|Brave/ },
];
const ANDROID_RULES: ClassRule[] = [
  { cls: "samsung", re: /SamsungBrowser\// },
  { cls: "miui", re: /MiuiBrowser|XiaoMi\// },
  { cls: "firefox-android", re: /Firefox\// },
];
const DESKTOP_RULES: ClassRule[] = [
  { cls: "desktop-edge", re: /Edg\// },
  { cls: "desktop-firefox", re: /Firefox\// },
  { cls: "desktop-chrome", re: /Chrome\/|Chromium\// },
  { cls: "desktop-safari", re: /Safari\// },
];

export function detectBrowser(
  ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
  opts: { touchPoints?: number; standalone?: boolean } = {},
): BrowserInfo {
  const touchPoints = opts.touchPoints ?? (typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints);
  const platform = detectPlatform(ua, touchPoints);
  const iosVersion = platform === "ios" ? parseIosVersion(ua) : null;
  const info = (cls: BrowserClass, app: string | null = null): BrowserInfo => ({
    cls,
    platform,
    iosVersion,
    app,
  });

  if (platform !== "desktop" && !NOT_IN_APP.test(ua)) {
    const inApp = platform === "ios" ? "in-app-ios" : "in-app-android";
    const hit = IN_APP_RULES.find((r) => r.re.test(ua));
    if (hit) return info(inApp, hit.app);
    if (platform === "android" && ANDROID_WEBVIEW.test(ua)) return info(inApp);
  }
  if (platform === "ios") {
    if (opts.standalone ?? isStandalone()) return info("ios-safari-standalone");
    return info(IOS_RULES.find((r) => r.re.test(ua))?.cls ?? "ios-safari");
  }
  if (platform === "android") return info(ANDROID_RULES.find((r) => r.re.test(ua))?.cls ?? "android-chrome");
  return info(DESKTOP_RULES.find((r) => r.re.test(ua))?.cls ?? "desktop-chrome");
}

function parseIosVersion(ua: string): number | null {
  const m = / OS (\d+)_/.exec(ua) ?? /Version\/(\d+)/.exec(ua);
  return m ? Number(m[1]) : null;
}

/** In-app browser classes: open-in-browser beats every other hint. */
export function isInApp(cls: BrowserClass): boolean {
  return cls === "in-app-android" || cls === "in-app-ios";
}

/**
 * Android "Open in Chrome": an intent URL that keeps the `#secret` fragment. Intent.parseUri splits on the LAST `#`,
 * so `#<secret>` stays part of the data URI. The secret never moves to the path or query (ADR-0004).
 */
export function chromeIntentUrl(link: string): string {
  const u = new URL(link);
  const fallback = encodeURIComponent(u.href);
  const scheme = u.protocol.replace(":", ""); // https in production; http for a local dev server
  return `intent://${u.host}${u.pathname}${u.search}${u.hash}#Intent;scheme=${scheme};package=com.android.chrome;S.browser_fallback_url=${fallback};end`;
}

/** iOS 17+: `x-safari-https://…` opens the link in Safari from another app's browser. Null when unavailable. */
export function safariUrl(link: string, iosVersion: number | null): string | null {
  if (iosVersion === null || iosVersion < 17 || !/^https?:\/\//.test(link)) return null;
  return `x-safari-${link}`;
}

/** Where "Open in Chrome / Safari" goes for this browser, or null when a page can't open another browser. */
export function openInBrowserUrl(link: string, b: BrowserInfo): string | null {
  if (b.platform === "android") return /^https?:\/\//.test(link) ? chromeIntentUrl(link) : null;
  if (b.platform === "ios") return safariUrl(link, b.iosVersion);
  return null;
}

/** The browser we send people to from an in-app or unsupported browser. */
export function recommendedBrowser(platform: Platform): string {
  return platform === "ios" ? "Safari" : "Chrome";
}

export function isStandalone(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches)
  );
}

const INSTALL_HINT_KEY = "clearcall.installHintDismissed";

export function shouldShowInstallHint(): boolean {
  if (!isIosSafari() || isStandalone()) return false;
  try {
    return localStorage.getItem(INSTALL_HINT_KEY) !== "1";
  } catch {
    return true;
  }
}

export function dismissInstallHint(): void {
  try {
    localStorage.setItem(INSTALL_HINT_KEY, "1");
  } catch {
    // Storage blocked (private mode): the hint just comes back next time.
  }
}
