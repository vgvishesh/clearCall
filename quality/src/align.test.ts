import { describe, expect, it } from "vitest";
import {
  alignFrames,
  BAR_HEIGHT,
  CELL_WIDTH,
  CELLS,
  checksum,
  decodeCode,
  deliveryRatio,
  encodeFrameId,
  ID_MODULO,
  LUMA_OFF,
  LUMA_ON,
  REF_HEIGHT,
  REF_WIDTH,
  readBarcode,
  y4mFrameOffset,
  yuv420FrameBytes,
} from "./align.ts";

/** Render a luma plane with the barcode of `frame`, optional noise and blur-ish edges. */
function renderLuma(frame: number, noise = 0, seed = 1): Uint8Array {
  const luma = new Uint8Array(REF_WIDTH * REF_HEIGHT).fill(90);
  const code = encodeFrameId(frame);
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let y = 0; y < BAR_HEIGHT; y++)
    for (let x = 0; x < REF_WIDTH; x++) {
      const bit = (code >> Math.floor(x / CELL_WIDTH)) & 1;
      const v = (bit ? LUMA_ON : LUMA_OFF) + (rnd() - 0.5) * 2 * noise;
      luma[y * REF_WIDTH + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  return luma;
}

describe("frame id code", () => {
  it("round-trips every id and wraps at 4096", () => {
    for (let i = 0; i < ID_MODULO; i++) expect(decodeCode(encodeFrameId(i))).toBe(i);
    expect(decodeCode(encodeFrameId(ID_MODULO + 7))).toBe(7);
  });
  it("rejects all-black, all-white and single-bit corruptions", () => {
    expect(decodeCode(0)).toBeNull();
    expect(decodeCode(0xffff)).toBeNull();
    let undetected = 0;
    for (let i = 0; i < ID_MODULO; i += 17)
      for (let b = 0; b < CELLS; b++) if (decodeCode(encodeFrameId(i) ^ (1 << b)) !== null) undetected++;
    // Additive nibble checksum catches every single-bit flip.
    expect(undetected).toBe(0);
  });
  it("checksum of 0 is non-zero", () => expect(checksum(0)).toBe(5));
});

describe("readBarcode", () => {
  it("reads clean and noisy strips", () => {
    for (const f of [0, 1, 299, 1234, 4095]) {
      expect(readBarcode(renderLuma(f))).toBe(f);
      expect(readBarcode(renderLuma(f, 60, f + 3))).toBe(f);
    }
  });
  it("returns null for a strip without a code", () => {
    expect(readBarcode(new Uint8Array(REF_WIDTH * REF_HEIGHT).fill(128))).toBeNull();
    expect(readBarcode(new Uint8Array(REF_WIDTH * REF_HEIGHT))).toBeNull();
  });
});

describe("alignFrames", () => {
  it("maps each received frame to its reference frame", () => {
    const a = alignFrames([0, 1, 2, 3], 300);
    expect(a.pairs).toEqual([
      { recv: 0, ref: 0 },
      { recv: 1, ref: 1 },
      { recv: 2, ref: 2 },
      { recv: 3, ref: 3 },
    ]);
    expect(a.skipped + a.repeats + a.unreadable + a.outOfRange).toBe(0);
    expect(deliveryRatio(a)).toBe(1);
  });
  it("drops repeats (freezes), counts skipped frames and unreadable ones", () => {
    const a = alignFrames([10, 10, 10, 11, null, 15, 16], 300);
    expect(a.pairs.map((p) => p.ref)).toEqual([10, 11, 15, 16]);
    expect(a.pairs.map((p) => p.recv)).toEqual([0, 3, 5, 6]);
    expect(a.repeats).toBe(2);
    expect(a.unreadable).toBe(1);
    expect(a.skipped).toBe(3); // 12, 13, 14
    expect(deliveryRatio(a)).toBeCloseTo(4 / 7);
  });
  it("handles the reference clip looping without counting skips", () => {
    const a = alignFrames([298, 299, 0, 1], 300);
    expect(a.skipped).toBe(0);
    const b = alignFrames([298, 1], 300); // 299 and 0 lost across the wrap
    expect(b.skipped).toBe(2);
  });
  it("treats ids beyond the clip as corruption and backwards jumps as non-skips", () => {
    const a = alignFrames([5, 400, 6, 3, 4], 300);
    expect(a.outOfRange).toBe(1);
    expect(a.pairs.map((p) => p.ref)).toEqual([5, 6, 3, 4]);
    expect(a.skipped).toBe(0);
  });
  it("validates the clip length", () => {
    expect(() => alignFrames([], 0)).toThrow();
    expect(() => alignFrames([], ID_MODULO + 1)).toThrow();
  });
});

describe("y4m math", () => {
  it("computes 4:2:0 frame sizes and offsets", () => {
    expect(yuv420FrameBytes(640, 360)).toBe(345_600);
    expect(yuv420FrameBytes(5, 3)).toBe(15 + 2 * 3 * 2);
    expect(y4mFrameOffset(0, 50, 100)).toBe(50);
    expect(y4mFrameOffset(2, 50, 100)).toBe(50 + 2 * 106);
  });
});
