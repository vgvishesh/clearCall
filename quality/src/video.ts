/**
 * Video scoring: decode received media, read frame-ID barcodes, build frame-aligned raw pairs and run libvmaf.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  type Alignment,
  alignFrames,
  BAR_HEIGHT,
  REF_HEIGHT,
  REF_WIDTH,
  readBarcode,
  yuv420FrameBytes,
} from "./align.ts";
import { ensureDir, run } from "./util.ts";

const LUMA_BYTES = REF_WIDTH * REF_HEIGHT;
const FRAME_BYTES = yuv420FrameBytes(REF_WIDTH, REF_HEIGHT);

/** Stream-decode any video to yuv420p REF_WIDTH×REF_HEIGHT frames (bicubic scaling), one callback per frame. */
export function decodeFrames(file: string, onFrame: (yuv: Buffer, index: number) => void): Promise<number> {
  return new Promise((res, rej) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-fps_mode",
      "passthrough",
      "-vf",
      `scale=${REF_WIDTH}:${REF_HEIGHT}:flags=bicubic,format=yuv420p`,
      "-f",
      "rawvideo",
      "-",
    ]);
    let pending: Buffer = Buffer.alloc(0);
    let n = 0;
    let stderr = "";
    ff.stderr.on("data", (d) => {
      stderr += d;
    });
    ff.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= FRAME_BYTES) {
        onFrame(pending.subarray(0, FRAME_BYTES), n++);
        pending = pending.subarray(FRAME_BYTES);
      }
    });
    ff.on("error", rej);
    ff.on("close", (code) =>
      code === 0 ? res(n) : rej(new Error(`ffmpeg decode ${file}: ${stderr.slice(-1000)}`)),
    );
  });
}

/** Barcode id per decoded frame (null = unreadable). */
export async function readFrameIds(file: string): Promise<(number | null)[]> {
  const ids: (number | null)[] = [];
  await decodeFrames(file, (yuv) =>
    ids.push(readBarcode(new Uint8Array(yuv.buffer, yuv.byteOffset, LUMA_BYTES))),
  );
  return ids;
}

/** Parsed y4m header: byte length and frame count (frames without per-frame params). */
export function y4mInfo(file: string): { headerLen: number; frames: number; width: number; height: number } {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(512);
    readSync(fd, head, 0, 512, 0);
    const nl = head.indexOf(10);
    const header = head.subarray(0, nl).toString("latin1");
    const width = Number(/ W(\d+)/.exec(header)?.[1]);
    const height = Number(/ H(\d+)/.exec(header)?.[1]);
    const { size } = statSync(file);
    const frameBytes = yuv420FrameBytes(width, height);
    return { headerLen: nl + 1, frames: Math.floor((size - nl - 1) / (6 + frameBytes)), width, height };
  } finally {
    closeSync(fd);
  }
}

export interface VmafResult {
  vmaf_mean: number;
  vmaf_p5: number;
  vmaf_min: number;
  psnr_y: number;
  ssim: number;
  frames_scored: number;
  alignment: Omit<Alignment, "pairs"> & { aligned: number; delivery_ratio: number };
}

/**
 * Full-reference video score. `ref` must be a 640×360 4:2:0 y4m with the frame-ID barcode (prepare-media output);
 * `deg` is anything ffmpeg decodes (webm recording, mp4…). Received frames are aligned to reference frames by
 * barcode, repeats dropped, then libvmaf runs on the pairs with the barcode strip cropped from both.
 * `maxFrames` evenly subsamples aligned pairs to bound runtime/disk.
 */
export async function scoreVideo(
  ref: string,
  deg: string,
  workDir: string,
  maxFrames = 1800,
): Promise<VmafResult> {
  ensureDir(workDir);
  const info = y4mInfo(ref);
  if (info.width !== REF_WIDTH || info.height !== REF_HEIGHT)
    throw new Error(`reference must be ${REF_WIDTH}x${REF_HEIGHT}, got ${info.width}x${info.height}`);

  // Pass 1: ids only (cheap) → alignment and subsampling plan.
  const ids = await readFrameIds(deg);
  const alignment = alignFrames(ids, info.frames);
  const { pairs, ...counts } = alignment;
  if (pairs.length === 0) throw new Error(`no readable frame ids in ${deg} (${ids.length} frames decoded)`);
  const stride = Math.max(1, Math.ceil(pairs.length / maxFrames));
  const keep = new Map<number, number>(); // recv index → ref index
  pairs.forEach((p, i) => {
    if (i % stride === 0) keep.set(p.recv, p.ref);
  });

  // Pass 2: write aligned raw pairs.
  const refRaw = join(workDir, "ref.yuv");
  const degRaw = join(workDir, "deg.yuv");
  const refOut = openSync(refRaw, "w");
  const degOut = openSync(degRaw, "w");
  const fd = openSync(ref, "r");
  const refBuf = Buffer.alloc(FRAME_BYTES);
  try {
    await decodeFrames(deg, (yuv, i) => {
      const r = keep.get(i);
      if (r === undefined) return;
      readSync(fd, refBuf, 0, FRAME_BYTES, info.headerLen + r * (6 + FRAME_BYTES) + 6);
      writeSync(refOut, refBuf);
      writeSync(degOut, yuv);
    });
  } finally {
    closeSync(fd);
    closeSync(refOut);
    closeSync(degOut);
  }

  const logPath = join(workDir, "vmaf.json");
  const raw = ["-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", `${REF_WIDTH}x${REF_HEIGHT}`, "-r", "30"];
  const crop = `crop=${REF_WIDTH}:${REF_HEIGHT - BAR_HEIGHT}:0:${BAR_HEIGHT}`;
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    ...raw,
    "-i",
    degRaw,
    ...raw,
    "-i",
    refRaw,
    "-lavfi",
    `[0:v]${crop}[d];[1:v]${crop}[r];[d][r]libvmaf=log_fmt=json:log_path=${logPath}:feature=name=psnr|name=float_ssim:n_threads=4`,
    "-f",
    "null",
    "-",
  ]);
  const out = JSON.parse(readFileSync(logPath, "utf8")) as {
    frames: { metrics: Record<string, number> }[];
    pooled_metrics: Record<string, { mean: number; min: number }>;
  };
  rmSync(refRaw, { force: true });
  rmSync(degRaw, { force: true });
  const v = out.frames.map((f) => f.metrics.vmaf ?? 0).sort((a, b) => a - b);
  const pm = out.pooled_metrics;
  return {
    vmaf_mean: pm.vmaf?.mean ?? Number.NaN,
    vmaf_p5: v[Math.floor(v.length * 0.05)] ?? Number.NaN,
    vmaf_min: pm.vmaf?.min ?? Number.NaN,
    psnr_y: pm.psnr_y?.mean ?? Number.NaN,
    ssim: pm.float_ssim?.mean ?? Number.NaN,
    frames_scored: out.frames.length,
    alignment: {
      ...counts,
      aligned: pairs.length,
      delivery_ratio: pairs.length / (pairs.length + counts.skipped),
    },
  };
}
