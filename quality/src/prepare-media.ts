/**
 * Synthetic reference media for the lab → quality/.cache/media/ (never into reference-media/, which is owner-only).
 *
 *   pnpm --filter @clearcall/quality exec tsx src/prepare-media.ts [--force]
 *
 * Corpus ids (profiles/*.yaml `corpus:`):
 *   speech_clean  macOS `say` sentences, two voices, 48 kHz mono s16 wav
 *   speech_noisy  speech_clean + pink noise at 10 dB SNR (whole-file RMS)
 *   music         synthetic chord/arpeggio/bass sequence (tonal, sustained — stresses NS/AGC/DTX)
 *   talking_head  640×360@30 y4m, low/moderate motion (Mandelbrot zoom), palindromic 10 s loop
 *   motion        640×360@30 y4m, high motion (testsrc2), palindromic 10 s loop
 * Every video frame carries the frame-ID barcode (align.ts); generation is verified by decoding every frame.
 * When owner media exists in quality/reference-media/ the lab prefers it (see corpusFiles()).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { geqChromaExpr, geqLumaExpr, REF_HEIGHT, REF_WIDTH } from "./align.ts";
import { ensureDir, have, log, MEDIA_DIR, parseArgs, QUALITY_DIR, run } from "./util.ts";
import { readFrameIds, y4mInfo } from "./video.ts";

export type CorpusId = "speech_clean" | "speech_noisy" | "music" | "talking_head" | "motion";
export const AUDIO_CORPORA: CorpusId[] = ["speech_clean", "speech_noisy", "music"];
export const VIDEO_CORPORA: CorpusId[] = ["talking_head", "motion"];

export interface MediaManifest {
  generated: string;
  synthetic: true;
  files: Record<CorpusId, { path: string; seconds: number; frames?: number }>;
  /** Clean speech that speech_noisy was made from (PESQ reference against clean). */
  cleanOf: Partial<Record<CorpusId, CorpusId>>;
}

const SENTENCES: [voice: string, text: string][] = [
  ["Samantha", "The birch canoe slid on the smooth planks."],
  ["Daniel", "Glue the sheet to the dark blue background."],
  ["Samantha", "It's easy to tell the depth of a well."],
  ["Daniel", "These days a chicken leg is a rare dish."],
  ["Samantha", "Rice is often served in round bowls."],
  ["Daniel", "The juice of lemons makes fine punch."],
  ["Samantha", "The box was thrown beside the parked truck."],
  ["Daniel", "Four hours of steady work faced us."],
];

const VIDEO_SECONDS_HALF = 5; // forward + reversed = 10 s seamless loop (300 frames)
const SNR_DB = 10;

async function meanVolumeDb(file: string): Promise<number> {
  const r = await run("ffmpeg", ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
  const m = /mean_volume: (-?[\d.]+) dB/.exec(r.stderr);
  if (!m) throw new Error(`volumedetect failed for ${file}`);
  return Number(m[1]);
}

async function durationS(file: string): Promise<number> {
  const r = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(r.stdout.trim());
}

const WAV = ["-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le"];

async function makeSpeech(out: string, tmp: string): Promise<void> {
  if (!(await have("say")))
    throw new Error("macOS `say` not found — speech corpus needs macOS (or owner media)");
  const parts: string[] = [];
  for (const [i, [voice, text]] of SENTENCES.entries()) {
    const aiff = join(tmp, `s${i}.aiff`);
    await run("say", ["-v", voice, "-o", aiff, text]);
    parts.push(aiff);
  }
  // Sentences separated by 0.5 s of silence, 0.5 s lead-in, normalized to -23 LUFS-ish via loudnorm.
  const inputs = parts.flatMap((p) => ["-i", p]);
  const chain = parts.map(
    (_, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=mono,apad=pad_dur=0.5[a${i}]`,
  );
  const concat = `${parts.map((_, i) => `[a${i}]`).join("")}concat=n=${parts.length}:v=0:a=1,adelay=500,loudnorm=I=-23:TP=-2[out]`;
  await run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputs,
    "-filter_complex",
    [...chain, concat].join(";"),
    "-map",
    "[out]",
    ...WAV,
    out,
  ]);
}

async function makeNoisy(clean: string, out: string, tmp: string): Promise<void> {
  const secs = await durationS(clean);
  const noise = join(tmp, "pink.wav");
  await run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `anoisesrc=color=pink:amplitude=0.3:seed=1:sample_rate=48000:duration=${secs}`,
    ...WAV,
    noise,
  ]);
  const gainDb = (await meanVolumeDb(clean)) - SNR_DB - (await meanVolumeDb(noise));
  await run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    clean,
    "-i",
    noise,
    "-filter_complex",
    `[1:a]volume=${gainDb.toFixed(2)}dB[n];[0:a][n]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[out]`,
    "-map",
    "[out]",
    ...WAV,
    out,
  ]);
}

/** Chords C–Am–F–G (2 s each), plucked triads + arpeggio + bass. Tonal and sustained on purpose. */
export function musicExpr(): string {
  const idx = "mod(floor(t/2),4)";
  const root = `if(eq(${idx},0),261.63,if(eq(${idx},1),220.0,if(eq(${idx},2),174.61,196.0)))`;
  const third = `if(eq(${idx},1),1.1892,1.2599)`;
  const step = "mod(floor(t*4),4)";
  const arp = `if(eq(${step},0),1,if(eq(${step},1),${third},if(eq(${step},2),1.4983,2)))`;
  const pluck = "exp(-3*mod(t,0.5))";
  const pad = `0.10*sin(2*PI*${root}*t)+0.05*sin(4*PI*${root}*t)+0.08*sin(2*PI*${root}*${third}*t)+0.08*sin(2*PI*${root}*1.4983*t)`;
  const lead = `0.12*exp(-6*mod(t,0.25))*sin(2*PI*2*${root}*${arp}*t)`;
  const bass = `0.15*exp(-1.5*mod(t,1))*sin(PI*${root}*t)`;
  return `${pluck}*(${pad})+${lead}+${bass}`;
}

async function makeMusic(out: string): Promise<void> {
  await run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='${musicExpr()}':s=48000:d=16`,
    "-af",
    "loudnorm=I=-20:TP=-2",
    ...WAV,
    out,
  ]);
}

async function makeVideo(source: string, out: string): Promise<void> {
  const geq = `geq=lum='${geqLumaExpr()}':cb='${geqChromaExpr()}':cr='${geqChromaExpr()}'`;
  await run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `${source}${source.includes("=") ? ":" : "="}size=${REF_WIDTH}x${REF_HEIGHT}:rate=30`,
    "-filter_complex",
    `[0:v]trim=duration=${VIDEO_SECONDS_HALF},setpts=PTS-STARTPTS,format=yuv420p,split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0,${geq}[out]`,
    "-map",
    "[out]",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "yuv4mpegpipe",
    out,
  ]);
}

async function verifyVideo(file: string): Promise<number> {
  const info = y4mInfo(file);
  const ids = await readFrameIds(file);
  const bad = ids.findIndex((id, i) => id !== i);
  if (ids.length !== info.frames || bad >= 0)
    throw new Error(
      `${file}: barcode verification failed at frame ${bad} (read ${ids[bad]}), ${ids.length} frames`,
    );
  return info.frames;
}

export function manifestPath(): string {
  return join(MEDIA_DIR, "manifest.json");
}

export function loadManifest(): MediaManifest | null {
  return existsSync(manifestPath())
    ? (JSON.parse(readFileSync(manifestPath(), "utf8")) as MediaManifest)
    : null;
}

/** Corpus id → file. Owner media in reference-media/<id>.{wav,y4m} wins over synthetic media. */
export function corpusFile(id: CorpusId, manifest: MediaManifest): string {
  const ext = VIDEO_CORPORA.includes(id) ? "y4m" : "wav";
  const owner = join(QUALITY_DIR, "reference-media", `${id}.${ext}`);
  if (existsSync(owner)) return owner;
  return join(MEDIA_DIR, manifest.files[id].path);
}

export async function prepareMedia(force = false): Promise<MediaManifest> {
  const existing = loadManifest();
  if (existing && !force) return existing;
  for (const tool of ["ffmpeg", "ffprobe"]) if (!(await have(tool))) throw new Error(`${tool} not found`);
  ensureDir(MEDIA_DIR);
  const tmp = ensureDir(join(MEDIA_DIR, "tmp"));
  const f = (n: string) => join(MEDIA_DIR, n);

  log("speech_clean (say)");
  await makeSpeech(f("speech_clean.wav"), tmp);
  log(`speech_noisy (pink noise @ ${SNR_DB} dB SNR)`);
  await makeNoisy(f("speech_clean.wav"), f("speech_noisy.wav"), tmp);
  log("music (synthetic chord sequence)");
  await makeMusic(f("music.wav"));
  log("talking_head.y4m (mandelbrot + frame-ID barcode)");
  await makeVideo("mandelbrot=maxiter=256", f("talking_head.y4m"));
  log("motion.y4m (testsrc2 + frame-ID barcode)");
  await makeVideo("testsrc2", f("motion.y4m"));

  log("verifying barcodes on every frame");
  const thFrames = await verifyVideo(f("talking_head.y4m"));
  const moFrames = await verifyVideo(f("motion.y4m"));
  rmSync(tmp, { recursive: true, force: true });

  const manifest: MediaManifest = {
    generated: new Date().toISOString(),
    synthetic: true,
    files: {
      speech_clean: { path: "speech_clean.wav", seconds: await durationS(f("speech_clean.wav")) },
      speech_noisy: { path: "speech_noisy.wav", seconds: await durationS(f("speech_noisy.wav")) },
      music: { path: "music.wav", seconds: await durationS(f("music.wav")) },
      talking_head: { path: "talking_head.y4m", seconds: thFrames / 30, frames: thFrames },
      motion: { path: "motion.y4m", seconds: moFrames / 30, frames: moFrames },
    },
    cleanOf: { speech_noisy: "speech_clean" },
  };
  writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  prepareMedia(args.has("force"))
    .then((m) => {
      for (const [id, v] of Object.entries(m.files))
        console.log(
          `${id.padEnd(13)} ${v.path.padEnd(18)} ${v.seconds.toFixed(1)} s${v.frames ? ` ${v.frames} frames` : ""}`,
        );
      console.log(`→ ${MEDIA_DIR}`);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
