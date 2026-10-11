import { describe, expect, it } from "vitest";
import { lossEmulation, WORKER_SRC } from "./loss-emu.ts";
import { gilbertParams } from "./netem.ts";

describe("loss emulation", () => {
  it("tells the encoder the loss rate and embeds the netem Gilbert parameters", () => {
    const e = lossEmulation(5, 1);
    const { p, r } = gilbertParams(5);
    expect(e.chromiumArgs).toEqual(["--force-fieldtrials=WebRTC-Audio-OpusMinPacketLossRate/Enabled-5/"]);
    expect(e.initScript).toContain(`p: ${p}, r: ${r}`);
    expect(e.note).toMatch(/EMULATED/);
  });

  it("the worker's Gilbert chain realizes the mean loss", () => {
    // Run the worker's transform logic on 100k fake frames.
    let transform: ((f: number, c: { enqueue(x: number): void }) => void) | null = null;
    const g = {
      onrtctransform: null as null | ((ev: unknown) => void),
      TransformStream: class {
        constructor(o: { transform: typeof transform }) {
          transform = o.transform;
        }
      },
    };
    const { p, r } = gilbertParams(5);
    new Function("self", `with (self) { ${WORKER_SRC}; self.onrtctransform = onrtctransform; }`)(g);
    const readable = { pipeThrough: () => ({ pipeTo: () => {} }) };
    g.onrtctransform!({ transformer: { options: { p, r, seed: 7919 }, readable, writable: {} } });
    let kept = 0;
    const N = 100_000;
    for (let i = 0; i < N; i++) transform!(i, { enqueue: () => kept++ });
    expect(1 - kept / N).toBeGreaterThan(0.04);
    expect(1 - kept / N).toBeLessThan(0.06);
  });
});
