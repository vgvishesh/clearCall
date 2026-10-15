import { describe, expect, it } from "vitest";
import { emptyState } from "../../core/fake/FakeCallController.ts";
import type { CallState, MediaRequest } from "../../core/types.ts";
import type { BrowserInfo } from "../platform.ts";
import { lobbyCoach } from "./Lobby.tsx";

const IN_APP: BrowserInfo = { cls: "in-app-android", platform: "android", iosVersion: null, app: "WhatsApp" };
const CHROME: BrowserInfo = { cls: "android-chrome", platform: "android", iosVersion: null, app: null };

function lobby(mediaRequest: MediaRequest, over: Partial<CallState> = {}, granted = true): CallState {
  const s = emptyState();
  return {
    ...s,
    phase: "lobby",
    ...over,
    local: { ...s.local, mediaRequest, camAvailable: granted, micAvailable: granted },
  };
}

describe("lobbyCoach", () => {
  it("in-app browser: open-elsewhere card first, Tap Allow while trying here anyway, preview once working", () => {
    expect(lobbyCoach(lobby("not-asked"), IN_APP)).toBe("in-app");
    expect(lobbyCoach(lobby("asking"), IN_APP)).toBe("asking");
    expect(lobbyCoach(lobby("done"), IN_APP)).toBeNull();
    const denied = lobby("done", { error: { code: "permission-denied" } }, false);
    expect(lobbyCoach(denied, IN_APP)).toBe("in-app");
  });

  it("normal browser: prime → asking → help when blocked → preview", () => {
    expect(lobbyCoach(lobby("not-asked"), CHROME)).toBe("prime");
    expect(lobbyCoach(lobby("asking"), CHROME)).toBe("asking");
    expect(lobbyCoach(lobby("done", { error: { code: "permission-denied" } }, false), CHROME)).toBe("help");
    expect(lobbyCoach(lobby("done"), CHROME)).toBeNull();
  });
});
