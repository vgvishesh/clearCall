/**
 * Run scorers on arbitrary file pairs (scorer validation, ad-hoc checks, WhatsApp captures).
 *
 *   tsx src/score.ts --video-ref talking_head.y4m --video-deg rec.webm
 *   tsx src/score.ts --speech-ref speech_clean.wav --speech-deg rec.webm [--dnsmos]
 *   tsx src/score.ts --music-ref music.wav --music-deg rec.webm
 *   tsx src/score.ts --dnsmos-only file.wav
 * Corpus ids (talking_head, speech_noisy, …) are accepted as refs. Prints JSON.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { dnsmos, scoreMusic, scoreSpeech } from "./audio.ts";
import { type CorpusId, corpusFile, prepareMedia } from "./prepare-media.ts";
import { CACHE_DIR, parseArgs, timestamp } from "./util.ts";
import { scoreVideo } from "./video.ts";

async function resolveRef(x: string): Promise<string> {
  if (existsSync(x)) return x;
  return corpusFile(x as CorpusId, await prepareMedia());
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const work = join(CACHE_DIR, "work", `score-${timestamp()}`);
  const out: Record<string, unknown> = {};
  const vr = a.get("video-ref");
  const vd = a.get("video-deg");
  if (vr && vd) out.video = await scoreVideo(await resolveRef(vr), vd, join(work, "video"));
  const sr = a.get("speech-ref");
  const sd = a.get("speech-deg");
  if (sr && sd) {
    out.speech = await scoreSpeech(await resolveRef(sr), sd, join(work, "speech"));
    if (a.has("dnsmos")) out.dnsmos = await dnsmos(sd, join(work, "dnsmos"));
  }
  const mr = a.get("music-ref");
  const md = a.get("music-deg");
  if (mr && md) out.music = await scoreMusic(await resolveRef(mr), md, join(work, "music"));
  const only = a.get("dnsmos-only");
  if (only) out.dnsmos = await dnsmos(await resolveRef(only), join(work, `dnsmos-${basename(only)}`));
  if (Object.keys(out).length === 0) {
    console.error("nothing to score — see usage at the top of src/score.ts");
    process.exit(2);
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
