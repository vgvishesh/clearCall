/**
 * Typed access to the QA hook (`window.__clearcall`, installed by the app when opened with `?qa=1`).
 * The contract lives in web/src/core/types.ts; testids in web/src/core/testids.ts.
 */
import type { Page } from "@playwright/test";
import type { CallState, LogEntry, QaHook, QaPeerStats, QaStatsSample } from "../../web/src/core/types.ts";

export { TID } from "../../web/src/core/testids.ts";
export type { CallState, LogEntry, QaHook, QaPeerStats, QaStatsSample };

declare global {
  interface Window {
    __clearcall?: QaHook;
  }
}

/** Selector for an element by data-testid. */
export const tid = (id: string): string => `[data-testid="${id}"]`;

/** Adds `qa=1` to any app URL (keeps the #fragment secret intact). */
export function withQa(url: string, base?: string): string {
  const u = new URL(url, base ?? "http://localhost");
  u.searchParams.set("qa", "1");
  return base || /^https?:/.test(url) ? u.toString() : `${u.pathname}${u.search}${u.hash}`;
}

export async function hasQaHook(page: Page): Promise<boolean> {
  return page.evaluate(() => typeof window.__clearcall === "object").catch(() => false);
}

export async function qaState(page: Page): Promise<CallState> {
  return page.evaluate(() => {
    if (!window.__clearcall) throw new Error("window.__clearcall missing (open the app with ?qa=1)");
    // Strip MediaStream objects (not serializable) — tests only need plain fields.
    const s = window.__clearcall.state();
    return JSON.parse(
      JSON.stringify(s, (k, v) => (k === "stream" ? (v ? { id: (v as MediaStream).id } : null) : v)),
    ) as CallState;
  });
}

export async function qaStats(page: Page): Promise<QaPeerStats[]> {
  return page.evaluate(async () => {
    if (!window.__clearcall) throw new Error("window.__clearcall missing (open the app with ?qa=1)");
    return window.__clearcall.stats();
  });
}

export async function qaLogs(page: Page): Promise<LogEntry[]> {
  return page.evaluate(() => window.__clearcall?.logs() ?? []);
}

export async function qaTimeline(page: Page): Promise<QaStatsSample[]> {
  return page.evaluate(() => window.__clearcall?.statsTimeline() ?? []);
}

export async function qaInject(
  page: Page,
  fault: "drop-signaling" | "restart-ice" | "kill-peer" | "cpu-overload",
  participantId?: string,
): Promise<void> {
  await page.evaluate(
    ([f, id]) => {
      if (!window.__clearcall) throw new Error("window.__clearcall missing");
      window.__clearcall.inject(f as "drop-signaling", id ?? undefined);
    },
    [fault, participantId ?? null] as const,
  );
}
