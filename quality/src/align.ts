/**
 * Frame-ID barcode burned into the reference video, and the math to align received frames with reference frames.
 *
 * Layout (in the 640×360 reference): the top BAR_HEIGHT rows hold CELLS cells of CELL_WIDTH px. Cell k is white
 * (luma 235) when bit k of the 16-bit code is 1, else black (16). Bits 0–11 = frame index mod 4096, bits 12–15 =
 * checksum (sum of the three index nibbles + 5) mod 16, so an all-black or all-white strip is never valid.
 * The strip is excluded from VMAF (both sides are cropped identically).
 */

export const REF_WIDTH = 640;
export const REF_HEIGHT = 360;
export const CELLS = 16;
export const CELL_WIDTH = REF_WIDTH / CELLS; // 40
export const BAR_HEIGHT = 32;
export const ID_BITS = 12;
export const ID_MODULO = 1 << ID_BITS;
export const LUMA_ON = 235;
export const LUMA_OFF = 16;

export function checksum(id: number): number {
  return ((id & 0xf) + ((id >> 4) & 0xf) + ((id >> 8) & 0xf) + 5) & 0xf;
}

/** 16-bit code for a frame index. */
export function encodeFrameId(frame: number): number {
  const id = ((frame % ID_MODULO) + ID_MODULO) % ID_MODULO;
  return id | (checksum(id) << ID_BITS);
}

/** Decode a 16-bit code; null when the checksum fails. */
export function decodeCode(code: number): number | null {
  const id = code & (ID_MODULO - 1);
  return ((code >> ID_BITS) & 0xf) === checksum(id) ? id : null;
}

/**
 * ffmpeg `geq` luma expression drawing the barcode for frame N (source frame counter).
 * Mirrors encodeFrameId exactly; prepare-media verifies every generated frame decodes to its own index.
 */
export function geqLumaExpr(): string {
  const n = "mod(N,4096)";
  const ck = "mod(mod(N,16)+mod(floor(N/16),16)+mod(floor(N/256),16)+5,16)";
  const code = `(${n}+4096*${ck})`;
  const bit = `mod(floor(${code}/pow(2,floor(X/${CELL_WIDTH}))),2)`;
  return `if(lt(Y,${BAR_HEIGHT}),${LUMA_OFF}+${LUMA_ON - LUMA_OFF}*${bit},p(X,Y))`;
}

/** Chroma: neutral grey in the (half-height) strip so the bar is pure luma. */
export function geqChromaExpr(): string {
  return `if(lt(Y,${BAR_HEIGHT / 2}),128,p(X,Y))`;
}

/**
 * Read the code from a luma plane already scaled to REF_WIDTH×REF_HEIGHT.
 * Samples the inner 50% of every cell (robust to ringing/blur at cell edges) and thresholds at mid-grey.
 */
export function readBarcode(luma: Uint8Array, width = REF_WIDTH): number | null {
  let code = 0;
  const y0 = Math.floor(BAR_HEIGHT / 4);
  const y1 = Math.ceil((BAR_HEIGHT * 3) / 4);
  const mid = (LUMA_ON + LUMA_OFF) / 2;
  for (let k = 0; k < CELLS; k++) {
    const x0 = k * CELL_WIDTH + CELL_WIDTH / 4;
    const x1 = (k + 1) * CELL_WIDTH - CELL_WIDTH / 4;
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        sum += luma[y * width + x] ?? 0;
        count++;
      }
    }
    if (sum / count > mid) code |= 1 << k;
  }
  return decodeCode(code);
}

export interface AlignedPair {
  /** Index of the received (decoded) frame. */
  recv: number;
  /** Reference frame index (0-based within the reference clip). */
  ref: number;
}

export interface Alignment {
  pairs: AlignedPair[];
  /** Received frames whose barcode didn't decode. */
  unreadable: number;
  /** Consecutive repeats of the same id (renderer repeats / freezes in the recording). */
  repeats: number;
  /** Reference frames that never arrived between the first and last aligned frame. */
  skipped: number;
  /** Decoded ids that point outside the reference clip (corruption). */
  outOfRange: number;
}

/**
 * Align decoded ids (one per received frame, null = unreadable) to a looping reference clip of `refFrames` frames.
 * Keeps the first occurrence of each run of identical ids; counts reference frames skipped in between
 * (forward distance modulo the clip length, so loop wrap-around is not counted as skipping).
 */
export function alignFrames(ids: ReadonlyArray<number | null>, refFrames: number): Alignment {
  if (refFrames <= 0 || refFrames > ID_MODULO) throw new Error(`refFrames must be 1..${ID_MODULO}`);
  const pairs: AlignedPair[] = [];
  let unreadable = 0;
  let repeats = 0;
  let skipped = 0;
  let outOfRange = 0;
  let prev: number | null = null;
  ids.forEach((id, recv) => {
    if (id === null) {
      unreadable++;
      return;
    }
    if (id >= refFrames) {
      outOfRange++;
      return;
    }
    if (id === prev) {
      repeats++;
      return;
    }
    if (prev !== null) {
      const step = (id - prev + refFrames) % refFrames;
      // A step larger than half the clip is a backwards jump (reordering) — don't count it as skipping.
      if (step > 1 && step <= refFrames / 2) skipped += step - 1;
    }
    prev = id;
    pairs.push({ recv, ref: id });
  });
  return { pairs, unreadable, repeats, skipped, outOfRange };
}

/** Delivered-frame ratio: aligned frames / (aligned + skipped). */
export function deliveryRatio(a: Alignment): number {
  const total = a.pairs.length + a.skipped;
  return total === 0 ? 0 : a.pairs.length / total;
}

/** Byte offset of frame `i` in a y4m file whose header is `headerLen` bytes and frames have no per-frame params. */
export function y4mFrameOffset(i: number, headerLen: number, frameBytes: number): number {
  return headerLen + i * (6 + frameBytes); // "FRAME\n" + payload
}

export function yuv420FrameBytes(w: number, h: number): number {
  return w * h + 2 * Math.ceil(w / 2) * Math.ceil(h / 2);
}
