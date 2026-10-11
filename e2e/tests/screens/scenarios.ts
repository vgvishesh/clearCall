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
  { name: "lobby-denied", required: [...LOBBY, TID.retryMedia, TID.micToggle, TID.camToggle] },
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
  { name: "call-audio-blocked", required: [...CALL, TID.enableAudio], tiles: 1 },
  { name: "call-peer-failed", required: [...CALL, TID.retryPeer], tiles: 2 },
  { name: "ended", required: ENDED, requiredIos: [TID.installHint, TID.installHintDismiss] },
  { name: "ended-light", scenario: "ended", colorScheme: "light", required: ENDED },
  { name: "ended-lost", required: ENDED },
  { name: "error-room-full", required: [...ERROR, TID.errorAction, TID.newCallButton] },
  { name: "error-invalid-link", required: [...ERROR, TID.newCallButton] },
  { name: "error-unsupported", required: ERROR },
  { name: "error-signaling", required: [...ERROR, TID.errorAction] },
  { name: "error-version", required: [...ERROR, TID.errorAction] },
];
