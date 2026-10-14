import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { FakeCallController, type FakeOptions } from "../core/fake/FakeCallController.ts";
import { buildScenario } from "../core/fake/scenarios.ts";
import { TID } from "../core/testids.ts";
import { App, isCallLink } from "./App.tsx";

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

function fake(opts: FakeOptions = {}) {
  return new FakeCallController({ media: false, animateLevels: false, joinDelayMs: 0, ...opts });
}
function scenario(name: string) {
  return fake(buildScenario(name).options);
}

describe("App", () => {
  it("shows the error screen when the engine failed to start", () => {
    render(<App controller={null} />);
    expect(screen.getByTestId(TID.errorScreen)).toBeTruthy();
    expect(screen.getByTestId(TID.errorCode).textContent).toContain("app-failed");
  });

  it("Home → Start → Lobby → Join → Call → Leave → Ended → Rejoin", async () => {
    const c = fake({ onJoinParticipants: [{ id: "p1", name: "Maya" }] });
    render(<App controller={c} />);
    fireEvent.click(screen.getByTestId(TID.startCall));
    await screen.findByTestId(TID.lobby);
    expect(location.pathname).toBe("/c");

    const name = screen.getByTestId(TID.nameInput) as HTMLInputElement;
    expect(name.maxLength).toBe(40);
    fireEvent.input(name, { target: { value: "Sam" } });
    fireEvent.click(screen.getByTestId(TID.joinButton));
    await screen.findByTestId(TID.callScreen);
    await waitFor(() => expect(screen.getAllByTestId(TID.participantTile)).toHaveLength(1));
    expect(screen.getByTestId(TID.participantCount).textContent).toBe("2");
    expect(c.calls.find((x) => x.method === "join")?.args).toEqual(["Sam"]);

    fireEvent.click(screen.getByTestId(TID.micToggle));
    expect(c.state.value.local.micOn).toBe(false);
    expect(screen.getByTestId(TID.selfTile).dataset.mic).toBe("false");

    fireEvent.click(screen.getByTestId(TID.leaveButton));
    await screen.findByTestId(TID.endedScreen);
    fireEvent.click(screen.getByTestId(TID.rejoinButton));
    await screen.findByTestId(TID.lobby);
  });

  it("opening a call link prepares the lobby", async () => {
    history.replaceState(null, "", "/c#secret123");
    const c = fake();
    render(<App controller={c} />);
    await screen.findByTestId(TID.lobby);
    expect(c.calls[0]).toEqual({ method: "prepare", args: [{ link: location.href }] });
  });

  it.each(["/c", "/c#", "/c/"])("%s (no secret) is routed to the controller, not Home", async (url) => {
    history.replaceState(null, "", url);
    const href = location.href;
    const c = fake();
    render(<App controller={c} />);
    await waitFor(() => expect(c.calls[0]).toEqual({ method: "prepare", args: [{ link: href }] }));
    expect(screen.queryByTestId(TID.startCall)).toBeNull();
  });

  it("a link the controller rejects shows invalid-link with Start a new call", async () => {
    history.replaceState(null, "", "/c");
    const c = fake();
    // The real controller rejects a missing/malformed secret with phase "error" + invalid-link.
    c.prepare = async (opts) => {
      c.calls.push({ method: "prepare", args: [opts] });
      c.state.value = { ...c.state.peek(), phase: "error", error: { code: "invalid-link" } };
    };
    render(<App controller={c} />);
    await screen.findByTestId(TID.errorScreen);
    expect(screen.getByTestId(TID.errorCode).textContent).toContain("invalid-link");
    expect(screen.getByTestId(TID.newCallButton).textContent).toBe("Start a new call");
  });

  it("the home page is not a call link", () => {
    expect(isCallLink({ pathname: "/" })).toBe(false);
    expect(isCallLink({ pathname: "/call" })).toBe(false);
    expect(isCallLink({ pathname: "/c" })).toBe(true);
  });

  it("lobby without a camera offers Join without camera", () => {
    render(<App controller={scenario("lobby-nocam")} />);
    expect(screen.getByTestId(TID.joinButton).textContent).toBe("Join without camera");
    expect(screen.getByRole("alert").textContent).toMatch(/camera/i);
  });

  it("music mode shows the headphones hint", () => {
    render(<App controller={scenario("lobby-music")} />);
    expect(screen.getByTestId(TID.musicModeToggle).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/headphones/)).toBeTruthy();
  });

  it("renders 9 remote tiles with per-participant attributes", () => {
    render(<App controller={scenario("call-10")} />);
    const tiles = screen.getAllByTestId(TID.participantTile);
    expect(tiles).toHaveLength(9);
    const jonas = tiles.find((t) => t.dataset.name === "Jonas")!;
    expect(jonas.dataset.participantId).toBe("p-jonas");
    expect(jonas.dataset.mic).toBe("false");
    expect(jonas.dataset.status).toBe("connected");
  });

  it("failed peer offers Retry", () => {
    const c = scenario("call-peer-failed");
    render(<App controller={c} />);
    fireEvent.click(screen.getByTestId(TID.retryPeer));
    expect(c.calls.at(-1)).toEqual({ method: "retryPeer", args: ["p-jonas"] });
  });

  it("video paused notice only while the CPU guard pauses video (ADR-0010)", () => {
    const c = scenario("call-video-paused");
    render(<App controller={c} />);
    expect(screen.getByTestId(TID.videoPausedNotice).textContent).toContain("audio");
    // Remote tiles show the avatar (peers stopped sending us video), not a frozen frame.
    for (const t of screen.getAllByTestId(TID.participantTile))
      expect(t.getAttribute("data-cam")).toBe("false");
    cleanup();
    render(<App controller={scenario("call-audio-blocked")} />);
    expect(screen.queryByTestId(TID.videoPausedNotice)).toBeNull();
  });

  it("reconnecting banner and audio unlock", () => {
    const c = scenario("call-reconnecting");
    render(<App controller={c} />);
    expect(screen.getByTestId(TID.reconnectingBanner)).toBeTruthy();
    cleanup();
    const b = scenario("call-audio-blocked");
    render(<App controller={b} />);
    fireEvent.click(screen.getByTestId(TID.enableAudio));
    expect(b.state.value.audioBlocked).toBe(false);
  });

  it("More sheet toggles music mode", () => {
    const c = scenario("call-3");
    render(<App controller={c} />);
    fireEvent.click(screen.getByTestId(TID.moreMenu));
    fireEvent.click(screen.getByTestId(TID.musicModeToggle));
    expect(c.state.value.local.mode).toBe("music");
  });

  it("More sheet closes from its close button", () => {
    render(<App controller={scenario("call-3")} />);
    fireEvent.click(screen.getByTestId(TID.moreMenu));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId(TID.sheetClose));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("blocked lobby retries media with the same link and name", () => {
    const c = scenario("lobby-denied");
    render(<App controller={c} />);
    fireEvent.click(screen.getByTestId(TID.retryMedia));
    expect(c.calls.at(-1)?.method).toBe("prepare");
  });

  it("blocked lobby keeps a full preview card with an avatar and the toggles", () => {
    render(<App controller={scenario("lobby-denied")} />);
    const preview = screen.getByTestId(TID.lobbyPreview);
    expect(preview.querySelector(".avatar")).toBeTruthy();
    expect(preview.querySelector(`[data-testid="${TID.micToggle}"]`)).toBeTruthy();
    expect(preview.querySelector(`[data-testid="${TID.camToggle}"]`)).toBeTruthy();
  });

  it("error screen recovery uses errorAction, not rejoinButton", () => {
    const c = scenario("error-room-full");
    render(<App controller={c} />);
    expect(screen.queryByTestId(TID.rejoinButton)).toBeNull();
    fireEvent.click(screen.getByTestId(TID.errorAction));
    expect(c.calls.at(-1)?.method).toBe("prepare");
  });

  it("self tile carries the per-participant attributes", () => {
    render(<App controller={scenario("call-3")} />);
    const self = screen.getByTestId(TID.selfTile);
    expect(self.dataset.participantId).toBe("self");
    expect(["true", "false"]).toContain(self.dataset.mic);
    expect(["true", "false"]).toContain(self.dataset.cam);
  });

  it("ended screen shows endedAt - joinedAt", () => {
    render(<App controller={scenario("ended")} />);
    expect(screen.getByTestId(TID.endedScreen).textContent).toContain("12:34");
  });

  it.each([
    ["error-room-full", "room-full"],
    ["error-invalid-link", "invalid-link"],
    ["error-unsupported", "unsupported"],
  ])("%s shows its code", (name, code) => {
    render(<App controller={scenario(name)} />);
    expect(screen.getByTestId(TID.errorCode).textContent).toContain(code);
  });
});
