import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { CallController } from "../core/types.ts";

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
}

export const HintsContext = createContext<UiHints>({});
