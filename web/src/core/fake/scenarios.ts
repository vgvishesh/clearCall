/**
 * Named FakeCallController scenarios for `?fake=1&scenario=<name>` (screenshots, UI dev).
 * Keep this list in sync with e2e/tests/screens/scenarios.ts.
 */
import type { CallState, LocalParticipant } from "../types.ts";
import type { FakeOptions, RemoteSpec } from "./FakeCallController.ts";
import { toRemote } from "./FakeCallController.ts";

/** Mirrors UiHints in src/ui/context.ts (core may not import ui). Test-only overrides. */
export interface UiHints {
  moreOpen?: boolean;
  browser?: { ua: string; touchPoints?: number; standalone?: boolean };
  askTroubleMs?: number;
  blockedRetries?: number;
}

/** One representative user agent per browser class, so screenshots show each browser's coach. */
const IOS_UA = (tail: string) =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${tail}`;
const ANDROID_UA = (tail: string) =>
  `Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ${tail}`;
const IOS_SAFARI = IOS_UA("Version/17.5 Mobile/15E148 Safari/604.1");
export const BROWSER_HINTS: Record<string, NonNullable<UiHints["browser"]>> = {
  "ios-safari": { ua: IOS_SAFARI, touchPoints: 5, standalone: false },
  "ios-safari-standalone": { ua: IOS_SAFARI, touchPoints: 5, standalone: true },
  "ios-chrome": {
    ua: IOS_UA("CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1"),
    touchPoints: 5,
    standalone: false,
  },
  "ios-other": { ua: IOS_UA("FxiOS/127.0 Mobile/15E148 Safari/605.1.15"), touchPoints: 5, standalone: false },
  "android-chrome": { ua: ANDROID_UA("Chrome/126.0.0.0 Mobile Safari/537.36"), touchPoints: 5 },
  samsung: { ua: ANDROID_UA("SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36"), touchPoints: 5 },
  miui: {
    ua: ANDROID_UA("Version/4.0 Chrome/112.0.5615.136 Mobile Safari/537.36 XiaoMi/MiuiBrowser/14.6.0-gn"),
    touchPoints: 5,
  },
  "firefox-android": {
    ua: "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
    touchPoints: 5,
  },
  "desktop-chrome": {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    touchPoints: 0,
  },
  "desktop-edge": {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    touchPoints: 0,
  },
  "desktop-safari": {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    touchPoints: 0,
  },
  "desktop-firefox": {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0",
    touchPoints: 0,
  },
};
const INAPP_ANDROID = {
  ua: "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A.240205.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36 Instagram 337.0.0.35.102 Android",
  touchPoints: 5,
};
const INAPP_IOS = {
  ua: IOS_UA("Mobile/15E148 Instagram 337.0.3.23.54 (iPhone15,2; iOS 17_5; en_US)"),
  touchPoints: 5,
};

export interface Scenario {
  options: FakeOptions;
  hints?: UiHints;
}

const LINK = "https://clearcall.app/c#Qm9uam91ciBjbGVhcmNhbGw";
const MIN = 60_000;

/** A varied cast: some cameras off, one muted, one long name, one weak connection. */
export const CAST: RemoteSpec[] = [
  { id: "p-maya", name: "Maya", hue: 200, speaking: true, x: 0.48 },
  { id: "p-jonas", name: "Jonas", hue: 28, micOn: false, portrait: true, x: 0.52 },
  { id: "p-priya", name: "Priya", hue: 330, x: 0.46 },
  { id: "p-alex", name: "Alexandria Montgomery-Whitfield", hue: 160, camOn: false },
  { id: "p-tomas", name: "Tomás", hue: 260, quality: "poor", portrait: true },
  { id: "p-aiko", name: "Aiko", hue: 90, micOn: false, x: 0.54 },
  { id: "p-leon", name: "Leon", hue: 12, camOn: false, micOn: false },
  { id: "p-sofia", name: "Sofia", hue: 300, portrait: true },
  { id: "p-kwame", name: "Kwame", hue: 45, x: 0.5 },
];

function touch(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

function local(over: Partial<LocalParticipant> = {}): Partial<LocalParticipant> {
  return { name: "Sam", canSwitchCamera: touch(), ...over };
}

type StateOver = Partial<Omit<CallState, "local">> & { local?: Partial<LocalParticipant> };

function inCall(n: number, over: StateOver = {}, cast: RemoteSpec[] = CAST): FakeOptions {
  const specs = cast.slice(0, Math.max(0, n - 1));
  const participants = specs.map(toRemote);
  return {
    initial: {
      phase: "in-call",
      link: LINK,
      participants,
      activeSpeakerId: participants.find((p) => p.speaking)?.id ?? null,
      joinedAt: Date.now() - (4 * MIN + 23_000),
      ...over,
      local: { ...local(), ...over.local },
    },
    onJoinParticipants: specs,
  };
}

function lobby(over: Partial<LocalParticipant> = {}, error: CallState["error"] = null): FakeOptions {
  return {
    initial: { phase: "lobby", link: LINK, error, local: local(over) },
    onJoinParticipants: CAST.slice(0, 1),
  };
}

/** Nothing asked yet: no stream, devices unknown. */
const NOT_ASKED: Partial<LocalParticipant> = {
  mediaRequest: "not-asked",
  stream: null,
  canSwitchCamera: false,
};
/** Both devices blocked after the browser question. */
const BLOCKED: Partial<LocalParticipant> = {
  camOn: false,
  micOn: false,
  camAvailable: false,
  micAvailable: false,
  canSwitchCamera: false,
};

function errorState(code: NonNullable<CallState["error"]>["code"]): FakeOptions {
  return { initial: { phase: "error", link: LINK, error: { code } }, onJoinParticipants: CAST.slice(0, 1) };
}

const builders: Record<string, () => Scenario> = {
  home: () => ({ options: { onJoinParticipants: CAST.slice(0, 1) } }),
  lobby: () => ({ options: lobby() }),
  "lobby-denied": () => ({
    options: lobby(
      { camOn: false, micOn: false, camAvailable: false, micAvailable: false, canSwitchCamera: false },
      { code: "permission-denied" },
    ),
  }),
  "lobby-nocam": () => ({
    options: lobby({ camOn: false, camAvailable: false, canSwitchCamera: false }, { code: "no-devices" }),
  }),
  "lobby-music": () => ({ options: lobby({ mode: "music" }) }),
  // Permission coach: nothing asked yet → Get ready; then the browser question; then blocked help per browser.
  "lobby-ask": () => ({ options: { ...lobby(NOT_ASKED), askDelayMs: 1500 } }),
  "lobby-asking": () => ({ options: lobby({ ...NOT_ASKED, mediaRequest: "asking" }) }),
  "lobby-asking-trouble": () => ({
    options: lobby({ ...NOT_ASKED, mediaRequest: "asking" }),
    hints: { askTroubleMs: 0 },
  }),
  "lobby-blocked-ios-reload": () => ({
    options: { ...lobby(BLOCKED, { code: "permission-denied" }), denyMedia: true },
    hints: { browser: BROWSER_HINTS["ios-safari"], blockedRetries: 1 },
  }),
  "lobby-inapp-android": () => ({ options: lobby(NOT_ASKED), hints: { browser: INAPP_ANDROID } }),
  "lobby-inapp-ios": () => ({ options: lobby(NOT_ASKED), hints: { browser: INAPP_IOS } }),
  "error-unsupported-inapp": () => ({
    options: errorState("unsupported"),
    hints: { browser: INAPP_ANDROID },
  }),
  "call-music-sheet": () => ({
    options: inCall(3, { local: local({ mode: "music" }) }),
    hints: { moreOpen: true },
  }),
  "call-reconnecting": () => ({ options: inCall(4, { phase: "reconnecting" }) }),
  "call-video-paused": () => ({ options: inCall(2, { videoLimited: "paused" }) }),
  "call-audio-blocked": () => ({ options: inCall(2, { audioBlocked: true }) }),
  "call-peer-failed": () => ({
    options: inCall(3, {}, [CAST[0]!, { ...CAST[1]!, status: "failed", camOn: false }]),
  }),
  ended: () => ({
    options: {
      initial: {
        phase: "ended",
        link: LINK,
        local: local({ camOn: false }),
        joinedAt: Date.now() - (12 * MIN + 34_000),
        endedAt: Date.now(),
      },
      onJoinParticipants: CAST.slice(0, 1),
    },
  }),
  "ended-lost": () => ({
    options: {
      initial: {
        phase: "ended",
        link: LINK,
        error: { code: "signaling-unavailable" },
        local: local({ camOn: false }),
        joinedAt: Date.now() - (38 * MIN + 5_000),
        endedAt: Date.now(),
      },
      onJoinParticipants: CAST.slice(0, 1),
    },
  }),
  "error-room-full": () => ({ options: errorState("room-full") }),
  "error-unsupported": () => ({ options: errorState("unsupported") }),
  "error-invalid-link": () => ({ options: errorState("invalid-link") }),
  "error-signaling": () => ({ options: errorState("signaling-unavailable") }),
  "error-version": () => ({ options: errorState("version-mismatch") }),
};
for (let n = 1; n <= 10; n++) builders[`call-${n}`] = () => ({ options: inCall(n) });
for (const [cls, browser] of Object.entries(BROWSER_HINTS))
  builders[`lobby-blocked-${cls}`] = () => ({
    options: { ...lobby(BLOCKED, { code: "permission-denied" }), denyMedia: true },
    hints: { browser },
  });

export const SCENARIO_NAMES = Object.keys(builders);

export function buildScenario(name: string): Scenario {
  const b = builders[name] ?? builders.home!;
  return b();
}
