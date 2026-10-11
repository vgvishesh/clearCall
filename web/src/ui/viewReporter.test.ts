import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewReporter } from "./viewReporter.ts";

describe("createViewReporter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces resize bursts into one device-pixel report", () => {
    const report = vi.fn();
    const r = createViewReporter(report, { delayMs: 100, dpr: () => 3 });
    r.observe("a", 100);
    r.observe("a", 150);
    r.observe("a", 200);
    expect(report).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(report).toHaveBeenCalledExactlyOnceWith("a", 600);
  });

  it("skips unchanged sizes and reports 0 on hide", () => {
    const report = vi.fn();
    const r = createViewReporter(report, { delayMs: 10, dpr: () => 1 });
    r.observe("a", 240);
    vi.advanceTimersByTime(10);
    r.observe("a", 241); // rounds to the same 8 px bucket
    vi.advanceTimersByTime(10);
    expect(report).toHaveBeenCalledTimes(1);
    r.hide("a");
    expect(report).toHaveBeenLastCalledWith("a", 0);
  });
});
