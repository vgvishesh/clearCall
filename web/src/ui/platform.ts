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

export function isStandalone(): boolean {
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
