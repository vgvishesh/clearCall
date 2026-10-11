/** Audio scoring: ffmpeg resampling + Python scorers via `uv run` (PEP 723 inline deps, no repo lockfile). */
import { join } from "node:path";
import { ensureDir, run, SCORERS_DIR } from "./util.ts";

export interface SpeechScore {
  pesq_wb: number;
  pesq_wb_min: number;
  segments: number;
  delay_ms: number;
  corr: number;
}
export interface MusicScore {
  snr_db: number;
  lsd_db: number;
  segments: number;
  delay_ms: number;
  corr: number;
}
export interface DnsmosScore {
  sig: number;
  bak: number;
  ovrl: number;
  windows: number;
}

/** Any audio/video container → mono PCM wav at `sr` (first audio stream). */
export async function toWav(input: string, out: string, sr: number): Promise<string> {
  await run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-af",
    `aresample=${sr}:filter_size=64:cutoff=0.97`,
    "-c:a",
    "pcm_s16le",
    out,
  ]);
  return out;
}

async function uvJson<T>(script: string, args: string[]): Promise<T> {
  const r = await run("uv", ["run", "--quiet", "--script", join(SCORERS_DIR, script), ...args]);
  const line = r.stdout.trim().split("\n").at(-1) ?? "";
  const parsed = JSON.parse(line) as T & { error?: string };
  if (parsed.error) throw new Error(`${script}: ${parsed.error}`);
  return parsed;
}

/** PESQ-WB of `deg` against `ref` (looping reference allowed; segment-wise aligned). */
export async function scoreSpeech(ref: string, deg: string, workDir: string): Promise<SpeechScore> {
  ensureDir(workDir);
  const r = await toWav(ref, join(workDir, "ref16k.wav"), 16000);
  const d = await toWav(deg, join(workDir, "deg16k.wav"), 16000);
  return uvJson<SpeechScore>("audio_score.py", ["--ref", r, "--deg", d, "--mode", "speech"]);
}

/** Music fidelity (gain-optimal SNR, log-spectral distance) at 48 kHz. */
export async function scoreMusic(ref: string, deg: string, workDir: string): Promise<MusicScore> {
  ensureDir(workDir);
  const r = await toWav(ref, join(workDir, "ref48k.wav"), 48000);
  const d = await toWav(deg, join(workDir, "deg48k.wav"), 48000);
  return uvJson<MusicScore>("audio_score.py", ["--ref", r, "--deg", d, "--mode", "music", "--segment", "4"]);
}

/** DNSMOS P.835 on any audio. */
export async function dnsmos(input: string, workDir: string): Promise<DnsmosScore> {
  ensureDir(workDir);
  const w = await toWav(input, join(workDir, "dnsmos16k.wav"), 16000);
  return uvJson<DnsmosScore>("dnsmos.py", ["--wav", w]);
}
