import { createContext } from "preact";
import { useContext, useMemo } from "preact/hooks";
import type { CallController } from "../core/types.ts";
import { type BrowserInfo, detectBrowser } from "./platform.ts";

export const CallContext = createContext<CallController | null>(null);

/** The only way UI code reaches the call engine. */
export function useCall(): CallController {
  const c = useContext(CallContext);
  if (!c) throw new Error("useCall() outside <CallContext.Provider>");
  return c;
}

/** UI-only hints a FakeCallController scenario can set (e.g. open the More sheet for a screenshot). */
export interface UiHints {
  moreOpen?: boolean;
  /** Test-only: render the permission coach as if in this browser (screenshots of every browser's steps). */
  browser?: { ua: string; touchPoints?: number; standalone?: boolean };
  /** Test-only: "Nothing showing?" after this many ms of asking (default 20 s). */
  askTroubleMs?: number;
  /** Test-only: "I've done it" was already pressed this many times. */
  blockedRetries?: number;
}

export const HintsContext = createContext<UiHints>({});

/** The browser class for the coach (a scenario hint may override it in fake mode). */
export function useBrowser(): BrowserInfo {
  const hints = useContext(HintsContext);
  return useMemo(() => {
    const o = hints.browser;
    return o
      ? detectBrowser(o.ua, { touchPoints: o.touchPoints, standalone: o.standalone })
      : detectBrowser();
  }, [hints.browser]);
}
