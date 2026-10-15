/**
 * Screens suite matrix: FakeCallController scenarios (web/src/core/fake/scenarios.ts) × devices,
 * with the testids each screen must show. Keep in sync with the fake scenario list.
 */
import { devices } from "@playwright/test";
import { TID } from "../../../web/src/core/testids.ts";

export type DeviceName = "iphone15" | "pixel7" | "desktop";

type ContextOptions = Parameters<import("@playwright/test").Browser["newContext"]>[0];

function strip(d: (typeof devices)[string]): ContextOptions {
  const { defaultBrowserType: _ignored, ...rest } = d;
  return rest;
}

export interface DeviceSpec {
  name: DeviceName;
  options: ContextOptions;
  mobile: boolean;
  /** Simulated safe areas (Chromium doesn't emulate env(safe-area-inset-*)): installed iPhone app worst case. */
  safeArea?: { top: number; bottom: number; island?: boolean };
}

export const DEVICES: DeviceSpec[] = [
  {
    name: "iphone15",
    options: strip(devices["iPhone 15"]),
    mobile: true,
    safeArea: { top: 59, bottom: 34, island: true },
  },
  { name: "pixel7", options: strip(devices["Pixel 7"]), mobile: true },
  {
    name: "desktop",
    options: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    mobile: false,
  },
];

export interface ScreenScenario {
  /** File name stem (also the scenario unless `scenario` is set). */
  name: string;
  scenario?: string;
  colorScheme?: "light" | "dark";
  required: string[];
  /** Extra testids required only on mobile (touch) devices. */
  requiredMobile?: string[];
  /** Extra testids required only on the iPhone (iOS Safari UA). */
  requiredIos?: string[];
  /** Expected number of remote participant tiles. */
  tiles?: number;
}

const HOME = [TID.startCall, TID.joinLinkInput, TID.joinLinkSubmit];
const LOBBY = [TID.lobby, TID.lobbyPreview, TID.nameInput, TID.joinButton, TID.micLevel, TID.shareLink];
const LOBBY_FULL = [...LOBBY, TID.micToggle, TID.camToggle, TID.musicModeToggle];
/** Lobby while the permission coach shows (no preview yet). */
const COACH = [TID.lobby, TID.nameInput, TID.joinButton, TID.shareLink];
const BLOCKED_BROWSERS = [
  "ios-safari",
  "ios-safari-standalone",
  "ios-chrome",
  "ios-other",
  "android-chrome",
  "samsung",
  "miui",
  "firefox-android",
  "desktop-chrome",
  "desktop-edge",
  "desktop-safari",
  "desktop-firefox",
];
const CALL = [
  TID.callScreen,
  TID.selfTile,
  TID.participantCount,
  TID.micToggle,
  TID.camToggle,
  TID.moreMenu,
  TID.leaveButton,
];
const ENDED = [TID.endedScreen, TID.rejoinButton, TID.newCallButton];
const ERROR = [TID.errorScreen, TID.errorCode];

export const SCENARIOS: ScreenScenario[] = [
  { name: "home", required: HOME },
  { name: "home-light", scenario: "home", colorScheme: "light", required: HOME },
  { name: "lobby", required: LOBBY_FULL, requiredMobile: [TID.flipCamera] },
  { name: "lobby-light", scenario: "lobby", colorScheme: "light", required: LOBBY_FULL },
  // Blocked camera+mic now shows the permission coach in place of the preview (permission-coach plan).
  { name: "lobby-denied", required: [...COACH, TID.permissionHelp, TID.retryMedia] },
  { name: "lobby-ask", required: [...COACH, TID.permissionPrime, TID.allowMedia, TID.joinSoundOnly] },
  {
    name: "lobby-ask-light",
    scenario: "lobby-ask",
    colorScheme: "light",
    required: [...COACH, TID.allowMedia],
  },
  { name: "lobby-asking", required: [...COACH, TID.permissionPrime] },
  { name: "lobby-asking-trouble", required: [...COACH, TID.permissionPrime], requiredMobile: [TID.copyLink] },
  ...BLOCKED_BROWSERS.map(
    (b): ScreenScenario => ({
      name: `lobby-blocked-${b}`,
      required: [...COACH, TID.permissionHelp, TID.retryMedia],
    }),
  ),
  { name: "lobby-blocked-ios-reload", required: [...COACH, TID.permissionHelp, TID.retryMedia] },
  { name: "lobby-inapp-android", required: [...COACH, TID.inAppNotice, TID.openInBrowser, TID.copyLink] },
  { name: "lobby-inapp-ios", required: [...COACH, TID.inAppNotice, TID.openInBrowser, TID.copyLink] },
  { name: "lobby-nocam", required: [...LOBBY, TID.micToggle, TID.retryMedia] },
  { name: "lobby-music", required: LOBBY_FULL },
  ...Array.from({ length: 10 }, (_, i): ScreenScenario => {
    const n = i + 1;
    return {
      name: `call-${n}`,
      required: n === 1 ? [...CALL, TID.shareLink] : [...CALL, TID.participantTile, TID.shareLink],
      requiredMobile: [TID.flipCamera],
      tiles: n - 1,
    };
  }),
  { name: "call-music-sheet", required: [TID.callScreen, TID.musicModeToggle, TID.sheetClose], tiles: 2 },
  { name: "call-reconnecting", required: [...CALL, TID.reconnectingBanner], tiles: 3 },
  { name: "call-video-paused", required: [...CALL, TID.videoPausedNotice], tiles: 1 },
  { name: "call-audio-blocked", required: [...CALL, TID.enableAudio], tiles: 1 },
  { name: "call-peer-failed", required: [...CALL, TID.retryPeer], tiles: 2 },
  { name: "ended", required: ENDED, requiredIos: [TID.installHint, TID.installHintDismiss] },
  { name: "ended-light", scenario: "ended", colorScheme: "light", required: ENDED },
  { name: "ended-lost", required: ENDED },
  { name: "error-room-full", required: [...ERROR, TID.errorAction, TID.newCallButton] },
  { name: "error-invalid-link", required: [...ERROR, TID.newCallButton] },
  { name: "error-unsupported", required: ERROR },
  { name: "error-unsupported-inapp", required: [...ERROR, TID.openInBrowser, TID.copyLink] },
  { name: "error-signaling", required: [...ERROR, TID.errorAction] },
  { name: "error-version", required: [...ERROR, TID.errorAction] },
];
