/**
 * Runs async tasks strictly one after another (FLOWS.md: per-peer signal processing must be serialized so an
 * `ice` never overtakes its `sdp`). A failing task is reported and never blocks later tasks.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private pending = 0;

  constructor(private readonly onError: (e: unknown) => void = () => {}) {}

  /** Enqueue a task. Resolves when this task has run (or was dropped by `clear`). */
  push(task: () => Promise<void> | void): Promise<void> {
    const gen = this.generation;
    this.pending++;
    const run = async () => {
      try {
        if (gen === this.generation) await task();
      } catch (e) {
        this.onError(e);
      } finally {
        this.pending--;
      }
    };
    this.tail = this.tail.then(run);
    return this.tail;
  }

  /** Drop every task that hasn't started yet. A running task finishes. */
  clear(): void {
    this.generation++;
  }

  get size(): number {
    return this.pending;
  }

  /** Resolves once everything queued so far has finished. */
  idle(): Promise<void> {
    return this.tail;
  }
}
