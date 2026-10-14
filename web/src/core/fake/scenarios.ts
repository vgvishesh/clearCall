/**
 * Named FakeCallController scenarios for `?fake=1&scenario=<name>` (screenshots, UI dev).
 * Keep this list in sync with e2e/tests/screens/scenarios.ts.
 */
import type { CallState, LocalParticipant } from "../types.ts";
import type { FakeOptions, RemoteSpec } from "./FakeCallController.ts";
import { toRemote } from "./FakeCallController.ts";

export interface UiHints {
  moreOpen?: boolean;
}

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

export const SCENARIO_NAMES = Object.keys(builders);

export function buildScenario(name: string): Scenario {
  const b = builders[name] ?? builders.home!;
  return b();
}
