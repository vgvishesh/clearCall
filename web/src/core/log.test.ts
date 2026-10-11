import { describe, expect, it, vi } from "vitest";
import { createLog, errInfo, short } from "./log.ts";
import { SerialQueue } from "./serial-queue.ts";
import { FakeClock } from "./testing/fake-clock.ts";

describe("log", () => {
  it("keeps a bounded ring with scope, level and time", () => {
    let t = 0;
    const log = createLog({ now: () => ++t, capacity: 3, consoleLevel: null });
    const a = log.scope("a");
    for (let i = 0; i < 5; i++) a.info(`m${i}`, { i });
    const e = log.entries();
    expect(e.map((x) => x.msg)).toEqual(["m2", "m3", "m4"]);
    expect(e[0]).toEqual({ t: 3, level: "info", scope: "a", msg: "m2", data: { i: 2 } });
    expect(log.written).toBe(5);
  });

  it("since() returns entries from a sequence number, clamped to the ring", () => {
    const log = createLog({ capacity: 3, consoleLevel: null });
    const s = log.scope("s");
    s.info("0");
    s.info("1");
    expect(log.since(1).map((e) => e.msg)).toEqual(["1"]);
    s.info("2");
    s.info("3");
    s.info("4");
    expect(log.since(0).map((e) => e.msg)).toEqual(["2", "3", "4"]);
    expect(log.since(4).map((e) => e.msg)).toEqual(["4"]);
    expect(log.since(5)).toEqual([]);
  });

  it("mirrors to console at or above the configured level", () => {
    const c = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const log = createLog({ console: c });
    const s = log.scope("x");
    s.debug("d");
    s.info("i");
    s.warn("w");
    s.error("e");
    expect(c.debug).not.toHaveBeenCalled();
    expect(c.info).not.toHaveBeenCalled();
    expect(c.warn).toHaveBeenCalledWith("[x] w", "");
    expect(c.error).toHaveBeenCalledOnce();
  });

  it("helpers", () => {
    expect(short("abcdefghijklmnop")).toBe("abcdef");
    expect(errInfo(new DOMException("no", "NotAllowedError"))).toEqual({
      err: "NotAllowedError",
      message: "no",
    });
    expect(errInfo("x")).toEqual({ err: "Error", message: "x" });
  });
});

describe("SerialQueue", () => {
  it("runs tasks strictly in order even when earlier ones are slower", async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    q.push(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    });
    q.push(() => {
      order.push(2);
    });
    await q.push(async () => {
      order.push(3);
    });
    expect(order).toEqual([1, 2, 3]);
  });

  it("isolates failures and supports clear()", async () => {
    const errors: unknown[] = [];
    const q = new SerialQueue((e) => errors.push(e));
    const order: string[] = [];
    q.push(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("a");
      q.clear();
    });
    q.push(() => {
      order.push("dropped");
    });
    await q.idle();
    q.push(() => {
      throw new Error("boom");
    });
    await q.push(() => {
      order.push("b");
    });
    expect(order).toEqual(["a", "b"]);
    expect(errors).toHaveLength(1);
    expect(q.size).toBe(0);
  });
});

describe("FakeClock", () => {
  it("fires timeouts and intervals in time order", () => {
    const c = new FakeClock(0);
    const fired: string[] = [];
    c.setTimeout(() => fired.push("t300"), 300);
    const iv = c.setInterval(() => fired.push(`i@${c.now()}`), 100);
    const cancelled = c.setTimeout(() => fired.push("never"), 50);
    c.clearTimeout(cancelled);
    c.advance(350);
    c.clearInterval(iv);
    c.advance(1000);
    expect(fired).toEqual(["i@100", "i@200", "t300", "i@300"]);
    expect(c.now()).toBe(1350);
  });
});
