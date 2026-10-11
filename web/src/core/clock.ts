/** Injected time source so every state machine in core is testable without real timers. */
export type TimerHandle = unknown;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle | undefined): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => {
    if (h !== undefined) globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>);
  },
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => {
    if (h !== undefined) globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>);
  },
};
