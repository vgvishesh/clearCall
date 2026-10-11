/**
 * Debounced `reportView` so tile resize animations (and rotation) produce one report per settled size,
 * not dozens. Heights are reported in device pixels, rounded to 8 px.
 */
export type ReportView = (participantId: string, heightPx: number) => void;

export interface ViewReporter {
  observe(id: string, cssHeight: number): void;
  hide(id: string): void;
  dispose(): void;
}

export function createViewReporter(
  report: ReportView,
  opts: { delayMs?: number; dpr?: () => number } = {},
): ViewReporter {
  const delay = opts.delayMs ?? 150;
  const dpr = opts.dpr ?? (() => (typeof devicePixelRatio === "number" ? devicePixelRatio : 1));
  const last = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const send = (id: string, px: number) => {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
    if (last.get(id) === px) return;
    last.set(id, px);
    report(id, px);
  };

  return {
    observe(id, cssHeight) {
      const px = Math.max(0, Math.round((cssHeight * dpr()) / 8) * 8);
      const t = timers.get(id);
      if (t) clearTimeout(t);
      timers.set(
        id,
        setTimeout(() => send(id, px), delay),
      );
    },
    hide(id) {
      send(id, 0);
      last.delete(id);
    },
    dispose() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
