/** User-facing copy for error codes. The controller reports codes; only the UI words them. */
import type { CallErrorCode } from "../core/types.ts";
import { type BrowserClass, type BrowserInfo, type Platform, recommendedBrowser } from "./platform.ts";

/** UI-only code for "the app itself failed to start" (e.g. controller factory threw). */
export type ScreenErrorCode = CallErrorCode | "app-failed";

export type ErrorAction = "retry" | "new-call" | "reload";

export interface ErrorCopy {
  title: string;
  body: string;
  actions: ErrorAction[];
}

export function errorCopy(code: ScreenErrorCode): ErrorCopy {
  switch (code) {
    case "room-full":
      return {
        title: "This call is full",
        body: "Calls have room for 10 people. Try again when someone leaves, or start a new call.",
        actions: ["retry", "new-call"],
      };
    case "invalid-link":
      return {
        title: "This link doesn’t work",
        body: "It may be incomplete. Ask for the link again, or start a new call.",
        actions: ["new-call"],
      };
    case "unsupported":
      return {
        title: "This browser can’t make calls",
        body: "Open the link in Safari on iPhone or iPad, or in Chrome, Edge, Firefox or Safari elsewhere.",
        actions: [],
      };
    case "signaling-unavailable":
      return {
        title: "Can’t reach Clearcall",
        body: "Check your internet connection and try again.",
        actions: ["retry"],
      };
    case "version-mismatch":
      return {
        title: "Clearcall was updated",
        body: "Reload to get the latest version, then join again.",
        actions: ["reload"],
      };
    case "permission-denied":
    case "no-devices":
      return {
        title: "Camera and microphone unavailable",
        body: "Allow access to your camera and microphone, then try again.",
        actions: ["retry"],
      };
    default:
      return {
        title: "Something went wrong",
        body: "Clearcall couldn’t start. Reload to try again.",
        actions: ["reload"],
      };
  }
}

/** One line on the Ended screen when the call ended because of an error rather than the user leaving. */
export function endedReason(code: CallErrorCode | undefined): string | null {
  if (!code) return null;
  if (code === "version-mismatch") return "Clearcall was updated. Reload to rejoin.";
  if (code === "signaling-unavailable") return "The connection was lost for too long.";
  return "The call ended unexpectedly.";
}

// ---------- Permission coach (senior-friendly: short sentences, plain words, **bold** = what to tap) ----------

/** Small inline-SVG picture next to a step, showing the thing to tap (see components/CoachArt.tsx). */
export type Glyph =
  | "aa"
  | "tune"
  | "lock"
  | "gear"
  | "app"
  | "switch"
  | "devices"
  | "menu"
  | "back"
  | "cam-blocked"
  | "cross";

/** One numbered step. `text` marks the words to look for with **double stars**. */
export interface CoachStep {
  glyph: Glyph;
  text: string;
}

const BACK_STEP: CoachStep = { glyph: "back", text: "Come back here and press the button below." };
const ALLOW_BOTH: CoachStep = { glyph: "switch", text: "Set **Camera** and **Microphone** to **Allow**." };

/** Three steps to turn camera and mic back on, per browser. In-app browsers never get steps (open-in-browser). */
export const BLOCKED_STEPS: Record<Exclude<BrowserClass, "in-app-android" | "in-app-ios">, CoachStep[]> = {
  "ios-safari": [
    { glyph: "aa", text: "Tap **aA** next to the web address." },
    { glyph: "gear", text: "Tap **Website Settings**." },
    ALLOW_BOTH,
  ],
  "ios-safari-standalone": [
    { glyph: "gear", text: "Open your phone’s **Settings** app." },
    { glyph: "app", text: "Find **Safari** (under **Apps**) and tap it." },
    { glyph: "switch", text: "Set **Camera** and **Microphone** to **Allow**. Then come back here." },
  ],
  "ios-chrome": [
    { glyph: "gear", text: "Open your phone’s **Settings** app." },
    { glyph: "app", text: "Find **Chrome** (under **Apps**) and tap it." },
    { glyph: "switch", text: "Turn on **Camera** and **Microphone**. Then come back here." },
  ],
  "ios-other": [
    { glyph: "gear", text: "Open your phone’s **Settings** app." },
    { glyph: "app", text: "Find this browser app (under **Apps**) and tap it." },
    { glyph: "switch", text: "Turn on **Camera** and **Microphone**. Then come back here." },
  ],
  "android-chrome": [
    { glyph: "tune", text: "Tap the **icon left of the web address**." },
    { glyph: "gear", text: "Tap **Permissions**." },
    { glyph: "switch", text: "Turn on **Camera** and **Microphone**." },
  ],
  samsung: [
    { glyph: "lock", text: "Tap the **lock** next to the web address." },
    { glyph: "gear", text: "Tap **Permissions**." },
    { glyph: "switch", text: "Turn on **Camera** and **Microphone**." },
  ],
  miui: [
    { glyph: "lock", text: "Tap the **lock** next to the web address." },
    { glyph: "gear", text: "Tap **Site settings**." },
    ALLOW_BOTH,
  ],
  "firefox-android": [
    { glyph: "lock", text: "Tap the **lock** left of the web address." },
    { glyph: "devices", text: "Find **Camera** and **Microphone**." },
    { glyph: "switch", text: "Set both to **Allowed**." },
  ],
  "desktop-chrome": [
    { glyph: "tune", text: "Click the **icon left of the web address**." },
    { glyph: "switch", text: "Turn on **Camera** and **Microphone**." },
    BACK_STEP,
  ],
  "desktop-edge": [
    { glyph: "lock", text: "Click the **lock** left of the web address." },
    { glyph: "gear", text: "Click **Permissions for this site**." },
    ALLOW_BOTH,
  ],
  "desktop-safari": [
    { glyph: "menu", text: "In the top menu, click **Safari** › **Settings for** this website." },
    ALLOW_BOTH,
    BACK_STEP,
  ],
  "desktop-firefox": [
    { glyph: "cam-blocked", text: "Click the **crossed-out camera** left of the web address." },
    { glyph: "cross", text: "Click **×** next to each **Blocked** item." },
    BACK_STEP,
  ],
};

/** What the browser's own question looks like, for the "Get ready" picture. The highlighted button is Allow. */
export interface PromptLook {
  layout: "row" | "stack";
  /** Button labels in on-screen order. */
  buttons: string[];
  allow: number;
  /** Where the question appears (the "Tap Allow" arrow points there). */
  where: "top" | "top-left" | "center" | "bottom";
}

const IOS_PROMPT: PromptLook = {
  layout: "row",
  buttons: ["Don’t Allow", "Allow"],
  allow: 1,
  where: "center",
};
const ROW_PROMPT: PromptLook = { layout: "row", buttons: ["Block", "Allow"], allow: 1, where: "center" };

export function promptLook(cls: BrowserClass): PromptLook {
  switch (cls) {
    case "ios-safari":
    case "ios-safari-standalone":
    case "ios-chrome":
    case "ios-other":
    case "in-app-ios":
      return IOS_PROMPT;
    case "android-chrome":
    case "in-app-android":
      return {
        layout: "stack",
        buttons: ["While visiting the site", "Only this time", "Don’t allow"],
        allow: 0,
        where: "center",
      };
    case "samsung":
      return { ...ROW_PROMPT, where: "bottom" };
    case "miui":
    case "firefox-android":
      return ROW_PROMPT;
    case "desktop-chrome":
    case "desktop-edge":
      return {
        layout: "stack",
        buttons: ["Allow while visiting the site", "Allow this time", "Never allow"],
        allow: 0,
        where: "top-left",
      };
    case "desktop-firefox":
      return { ...ROW_PROMPT, where: "top-left" };
    case "desktop-safari":
      return { ...IOS_PROMPT, where: "top" };
  }
}

const WHERE_TEXT: Record<PromptLook["where"], string> = {
  top: "Look near the top of the screen.",
  "top-left": "Look near the web address, top left.",
  center: "Look for the box in the middle of the screen.",
  bottom: "Look near the bottom of the screen.",
};

export interface CoachCopy {
  title: string;
  text: string;
}

const tapVerb = (p: Platform) => (p === "desktop" ? "Click" : "Tap");

/** "Get ready" (mediaRequest not-asked): what is about to happen, before the browser asks. */
export function primeCopy(p: Platform): CoachCopy {
  const who = p === "desktop" ? "Your browser" : "Your phone";
  return {
    title: `${who} will ask to use the camera and microphone.`,
    text: `${tapVerb(p)} **Allow**.`,
  };
}

/** mediaRequest "asking": the browser question is on screen. */
export function askingCopy(b: BrowserInfo): CoachCopy {
  return { title: `${tapVerb(b.platform)} **Allow**`, text: WHERE_TEXT[promptLook(b.cls).where] };
}

/** "asking" for too long (some app browsers never show the question). */
export function troubleCopy(b: BrowserInfo): CoachCopy {
  if (b.platform === "desktop")
    return { title: "Nothing showing?", text: "Reload the page and try once more." };
  return {
    title: "Nothing showing?",
    text: `Open this call in ${recommendedBrowser(b.platform)} instead.`,
  };
}

/** Lobby notice inside another app's browser (WhatsApp, Instagram, …). */
export function inAppCopy(b: BrowserInfo, canOpen: boolean): CoachCopy {
  const browser = recommendedBrowser(b.platform);
  const host = b.app ?? "This app";
  if (b.platform === "ios" && !canOpen)
    return {
      title: `Open this call in ${browser}`,
      text: `${host}’s browser can’t always use your camera. Tap **⋯**, then **Open in ${browser}**.`,
    };
  return {
    title: `Open this call in ${browser}`,
    text: `${host}’s browser can’t always use your camera and microphone. ${browser} can.`,
  };
}

/** `unsupported` error screen, worded for the browser we're in and whether we have the call link to hand over. */
export function unsupportedCopy(b: BrowserInfo, hasLink: boolean): ErrorCopy {
  const browser = recommendedBrowser(b.platform);
  if (b.cls === "in-app-android" || b.cls === "in-app-ios") {
    const host = b.app ?? "This app";
    const how =
      !hasLink || (b.platform === "ios" && (b.iosVersion ?? 0) < 17)
        ? `Tap ⋯, then Open in ${browser}.`
        : `Tap Open in ${browser} below.`;
    return {
      title: `Open this call in ${browser}`,
      body: `${host}’s browser can’t make calls. ${how}`,
      actions: [],
    };
  }
  if (b.platform === "desktop")
    return {
      title: "This browser can’t make calls",
      body: hasLink
        ? "Copy the link and open it in Chrome, Edge, Firefox or Safari."
        : "Please use Chrome, Edge, Firefox or Safari.",
      actions: [],
    };
  return {
    title: "This browser can’t make calls",
    body: hasLink ? `Open this call in ${browser}.` : `Please open Clearcall in ${browser}.`,
    actions: [],
  };
}

export interface DeviceHelp {
  title: string;
  /** Shown instead of steps (no-devices). */
  body: string | null;
  steps: CoachStep[];
}

/** Lobby copy when camera and/or microphone can't be used. */
export function deviceHelp(
  code: "permission-denied" | "no-devices",
  camAvailable: boolean,
  micAvailable: boolean,
  cls: BrowserClass,
): DeviceHelp {
  const what = !camAvailable && !micAvailable ? "camera and mic" : !camAvailable ? "camera" : "mic";
  if (code === "no-devices") {
    return {
      title: `No ${what} found`,
      body: "Another app may be using it. Close that app, then try again.",
      steps: [],
    };
  }
  const steps =
    cls === "in-app-android" || cls === "in-app-ios" ? BLOCKED_STEPS["android-chrome"] : BLOCKED_STEPS[cls];
  return {
    title: `Your ${what} ${what.includes(" and ") ? "are" : "is"} blocked`,
    body: null,
    steps,
  };
}

/** Lobby join button: says what you'll join with. */
export function joinLabel(opts: { joining: boolean; cam: boolean; mic: boolean }): string {
  if (opts.joining) return "Joining…";
  if (!opts.mic && !opts.cam) return "Join and just listen";
  if (!opts.cam) return "Join with sound only";
  if (!opts.mic) return "Join without mic";
  return "Join call";
}

/** Split "Tap **Allow**." into plain and bold parts for rendering. */
export function boldParts(text: string): { text: string; bold: boolean }[] {
  return text
    .split("**")
    .map((t, i) => ({ text: t, bold: i % 2 === 1 }))
    .filter((p) => p.text !== "");
}
