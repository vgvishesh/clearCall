import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { FakeCallController, type FakeOptions } from "../core/fake/FakeCallController.ts";
import { buildScenario } from "../core/fake/scenarios.ts";
import { TID } from "../core/testids.ts";
import { App, isCallLink } from "./App.tsx";
import { unsupportedLink } from "./screens/ErrorScreen.tsx";

const LINK = "https://clearcall.app/c#Qm9uam91ciBjbGVhcmNhbGw";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const IG_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36 Instagram 337.0";

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

  it("lobby without a camera offers Join with sound only and Try again asks again", () => {
    const c = scenario("lobby-nocam");
    render(<App controller={c} />);
    expect(screen.getByTestId(TID.joinButton).textContent).toBe("Join with sound only");
    expect(screen.getByRole("alert").textContent).toMatch(/camera/i);
    fireEvent.click(screen.getByTestId(TID.retryMedia));
    expect(c.calls.at(-1)?.method).toBe("requestMedia");
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

  it("blocked lobby shows three steps and “I’ve done it” asks again (no new link)", () => {
    const c = scenario("lobby-denied");
    render(<App controller={c} />);
    const help = screen.getByTestId(TID.permissionHelp);
    expect(help.querySelectorAll("li")).toHaveLength(3);
    expect(screen.getByTestId(TID.joinButton).textContent).toBe("Join and just listen");
    fireEvent.click(screen.getByTestId(TID.retryMedia));
    expect(c.calls.at(-1)).toEqual({ method: "requestMedia", args: [{}] });
    expect(c.calls.some((x) => x.method === "prepare")).toBe(false);
  });

  it.each([
    ["ios-safari", /aA/],
    ["ios-safari-standalone", /Settings/],
    ["android-chrome", /icon left of the web address/],
    ["samsung", /lock/],
    ["desktop-firefox", /crossed-out camera/],
  ])("blocked help is written for %s", (cls, first) => {
    render(
      <App
        controller={scenario(`lobby-blocked-${cls}`)}
        hints={buildScenario(`lobby-blocked-${cls}`).hints}
      />,
    );
    const steps = screen.getByTestId(TID.permissionHelp).querySelectorAll("li");
    expect(steps[0]!.textContent).toMatch(first);
  });

  it("iOS: still blocked after “I’ve done it” → Reload page", () => {
    const s = buildScenario("lobby-blocked-ios-reload");
    render(<App controller={fake(s.options)} hints={s.hints} />);
    expect(screen.getByTestId(TID.retryMedia).textContent).toBe("Reload page");
  });

  it("iOS: a retry that is still blocked turns the button into Reload page", async () => {
    const s = buildScenario("lobby-blocked-ios-safari");
    const c = fake({ ...s.options, askDelayMs: 0 });
    render(<App controller={c} hints={s.hints} />);
    fireEvent.click(screen.getByTestId(TID.retryMedia));
    await waitFor(() => expect(screen.getByTestId(TID.retryMedia).textContent).toBe("Reload page"));
  });

  it("Get ready: no prompt until a tap; Turn on camera & mic → asking → preview", async () => {
    const c = fake({ ...buildScenario("lobby-ask").options, askDelayMs: 0 });
    render(
      <App
        controller={c}
        hints={{ browser: { ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36" } }}
      />,
    );
    expect(screen.getByTestId(TID.permissionPrime).textContent).toMatch(/will ask to use the camera/);
    expect(screen.queryByTestId(TID.lobbyPreview)).toBeNull();
    expect(c.calls.some((x) => x.method === "requestMedia")).toBe(false);
    expect(screen.getByTestId(TID.joinButton).textContent).toBe("Join and just listen");
    fireEvent.click(screen.getByTestId(TID.allowMedia));
    expect(c.calls.at(-1)).toEqual({ method: "requestMedia", args: [{}] });
    await screen.findByTestId(TID.lobbyPreview);
    expect(screen.queryByTestId(TID.permissionPrime)).toBeNull();
    expect(screen.getByTestId(TID.joinButton).textContent).toBe("Join call");
  });

  it("Get ready: Join with sound only asks for the mic only", async () => {
    const c = fake({ ...buildScenario("lobby-ask").options, askDelayMs: 0 });
    render(<App controller={c} />);
    fireEvent.click(screen.getByTestId(TID.joinSoundOnly));
    expect(c.calls.at(-1)).toEqual({ method: "requestMedia", args: [{ video: false }] });
    await waitFor(() => expect(screen.getByTestId(TID.joinButton).textContent).toBe("Join with sound only"));
  });

  it("asking: Tap Allow, then after a while offers another browser", async () => {
    const s = buildScenario("lobby-asking");
    render(<App controller={fake(s.options)} hints={{ askTroubleMs: 30, browser: { ua: IG_ANDROID } }} />);
    // "Try here anyway" in an app's browser: the Tap Allow step, not the in-app card.
    expect(screen.queryByTestId(TID.inAppNotice)).toBeNull();
    expect(screen.getByTestId(TID.permissionPrime).textContent).toMatch(/Tap Allow/);
    cleanup();
    render(
      <App
        controller={fake(s.options)}
        hints={{ askTroubleMs: 30, browser: { ua: SAFARI_IOS, touchPoints: 5, standalone: false } }}
      />,
    );
    expect(screen.getByTestId(TID.permissionPrime).textContent).toMatch(/Tap Allow/);
    await waitFor(() => expect(screen.getByTestId(TID.openInBrowser)).toBeTruthy());
    expect(screen.getByTestId(TID.openInBrowser).getAttribute("href")).toMatch(/^x-safari-https:\/\//);
    expect(screen.getByTestId(TID.copyLink)).toBeTruthy();
  });

  it("in-app Android: Open in Chrome keeps the secret in the fragment, Copy link beside it", () => {
    const s = buildScenario("lobby-inapp-android");
    render(<App controller={fake(s.options)} hints={s.hints} />);
    const notice = screen.getByTestId(TID.inAppNotice);
    expect(notice.textContent).toMatch(/Open this call in Chrome/);
    const href = screen.getByTestId(TID.openInBrowser).getAttribute("href")!;
    expect(href).toMatch(
      /^intent:\/\/clearcall\.app\/c#Qm9uam91ciBjbGVhcmNhbGw#Intent;.*package=com\.android\.chrome;/,
    );
    expect(screen.getByTestId(TID.copyLink)).toBeTruthy();
    // Secondary "Try here anyway" (some app browsers can call); never the blocked-help steps.
    expect(screen.getByTestId(TID.allowMedia).textContent).toBe("Try here anyway");
    expect(screen.queryByTestId(TID.permissionHelp)).toBeNull();
  });

  it("in-app iOS: x-safari link on iOS 17, Copy link primary on iOS 16", () => {
    const s = buildScenario("lobby-inapp-ios");
    render(<App controller={fake(s.options)} hints={s.hints} />);
    expect(screen.getByTestId(TID.openInBrowser).getAttribute("href")).toBe(`x-safari-${LINK}`);
    cleanup();
    const ua16 = s.hints!.browser!.ua.replace(/17_5/g, "16_6");
    render(<App controller={fake(s.options)} hints={{ browser: { ua: ua16, touchPoints: 5 } }} />);
    expect(screen.queryByTestId(TID.openInBrowser)).toBeNull();
    expect(screen.getByTestId(TID.copyLink).className).toMatch(/btn--primary/);
    expect(screen.getByTestId(TID.inAppNotice).textContent).toMatch(/Open in Safari/);
  });

  it("Home → Start a call asks for camera and mic in the same tap", async () => {
    const c = fake({ initial: { local: { mediaRequest: "not-asked" } }, askDelayMs: 0 });
    render(<App controller={c} />);
    fireEvent.click(screen.getByTestId(TID.startCall));
    await waitFor(() => expect(c.calls.map((x) => x.method)).toEqual(["prepare", "requestMedia"]));
  });

  it("in a call, mic/cam of a never-granted device are enabled and ask for that device only", async () => {
    const c = fake({
      initial: {
        phase: "in-call",
        link: LINK,
        local: { mediaRequest: "not-asked", micOn: false, camOn: false },
      },
      askDelayMs: 0,
    });
    render(<App controller={c} />);
    const cam = screen.getByTestId(TID.camToggle) as HTMLButtonElement;
    const mic = screen.getByTestId(TID.micToggle) as HTMLButtonElement;
    expect(cam.disabled).toBe(false);
    expect(mic.disabled).toBe(false);
    fireEvent.click(cam);
    await waitFor(() => expect(c.state.value.local.camOn).toBe(true));
    // A late camera grant never turns the mic on.
    expect(c.state.value.local.micOn).toBe(false);
    fireEvent.click(screen.getByTestId(TID.micToggle));
    await waitFor(() => expect(c.state.value.local.micOn).toBe(true));
    expect(c.state.value.local.camOn).toBe(true);
  });

  it("unsupported with a call link offers Open in Chrome + Copy link", () => {
    const s = buildScenario("error-unsupported-inapp");
    render(<App controller={fake(s.options)} hints={s.hints} />);
    expect(screen.getByTestId(TID.openInBrowser).getAttribute("href")).toMatch(/^intent:\/\//);
    expect(screen.getByTestId(TID.copyLink)).toBeTruthy();
  });

  it("unsupported: link from the address bar when the controller has none; none on Home", () => {
    expect(unsupportedLink(null, { href: "https://x.app/c#abc", pathname: "/c", hash: "#abc" })).toBe(
      "https://x.app/c#abc",
    );
    expect(unsupportedLink(null, { href: "https://x.app/", pathname: "/", hash: "" })).toBeNull();
    expect(unsupportedLink(null, { href: "https://x.app/c", pathname: "/c", hash: "" })).toBeNull();
    const c = fake({ initial: { phase: "error", error: { code: "unsupported" } } });
    render(<App controller={c} hints={{ browser: { ua: CHROME_ANDROID } }} />);
    expect(screen.queryByTestId(TID.openInBrowser)).toBeNull();
    expect(screen.queryByTestId(TID.copyLink)).toBeNull();
    expect(screen.getByTestId(TID.errorScreen).textContent).toMatch(/Chrome/);
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
