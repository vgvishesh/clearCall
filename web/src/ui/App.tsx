import { useComputed } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { CallController } from "../core/types.ts";
import { Toast } from "./components/Toast.tsx";
import { CallContext, HintsContext, type UiHints, useCall } from "./context.ts";
import { Call } from "./screens/Call.tsx";
import { Ended } from "./screens/Ended.tsx";
import { ErrorScreen } from "./screens/ErrorScreen.tsx";
import { Home } from "./screens/Home.tsx";
import { Lobby } from "./screens/Lobby.tsx";

/**
 * Root. `controller === null` means the engine failed to start (e.g. factory threw) → error screen.
 * Screens are chosen by `state.phase`; the URL only matters on first load (`/c#secret` → prepare the lobby).
 */
export function App({ controller, hints = {} }: { controller: CallController | null; hints?: UiHints }) {
  if (!controller) {
    return (
      <Shell theme="auto">
        <ErrorScreen code="app-failed" controller={null} />
      </Shell>
    );
  }
  return (
    <CallContext.Provider value={controller}>
      <HintsContext.Provider value={hints}>
        <Router />
      </HintsContext.Provider>
    </CallContext.Provider>
  );
}

/**
 * Any `/c` URL is a call link, with or without a `#secret`: the controller validates the secret, so a missing or
 * malformed one ends on the Error screen (`invalid-link`, "Start a new call") instead of silently showing Home.
 */
export function isCallLink(loc: Pick<Location, "pathname">): boolean {
  return /^\/c\/?$/.test(loc.pathname);
}

function Router() {
  const c = useCall();
  const phase = useComputed(() => c.state.value.phase).value;
  const errorCode = useComputed(() => c.state.value.error?.code ?? null).value;

  // Opening a shared link goes straight to the lobby.
  useEffect(() => {
    if (c.state.peek().phase === "idle" && isCallLink(location)) void c.prepare({ link: location.href });
    return () => c.dispose();
  }, [c]);

  switch (phase) {
    case "idle":
      return <Shell theme="auto">{isCallLink(location) ? <Lobby /> : <Home />}</Shell>;
    case "lobby":
      return (
        <Shell theme="auto">
          <Lobby />
        </Shell>
      );
    case "joining":
    case "in-call":
    case "reconnecting":
      return (
        <Shell theme="dark">
          <Call />
        </Shell>
      );
    case "ended":
      return (
        <Shell theme="auto">
          <Ended />
        </Shell>
      );
    default:
      return (
        <Shell theme="auto">
          <ErrorScreen code={errorCode ?? "app-failed"} controller={c} />
        </Shell>
      );
  }
}

function Shell({ theme, children }: { theme: "auto" | "dark"; children: preact.ComponentChildren }) {
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <>
      {children}
      <Toast />
    </>
  );
}
