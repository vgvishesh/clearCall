/**
 * Proves the scorers end-to-end on synthetic pairs: reference vs ffmpeg-degraded copies whose ordering is known.
 * Each degraded copy starts mid-loop (like a real recording) so alignment is exercised too.
 *
 *   pnpm --filter @clearcall/quality exec tsx src/validate-scorers.ts
 * Exits 1 if any expected ordering (e.g. VMAF@1500k > VMAF@300k) does not hold.
 */
import { join } from "node:path";
import { dnsmos, scoreMusic, scoreSpeech } from "./audio.ts";
import { corpusFile, prepareMedia } from "./prepare-media.ts";
import { CACHE_DIR, ensureDir, log, run } from "./util.ts";
import { scoreVideo } from "./video.ts";

const DIR = ensureDir(join(CACHE_DIR, "validate"));
const WORK = join(CACHE_DIR, "work", "validate");

async function ff(args: string[]): Promise<void> {
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
}

async function main() {
  const m = await prepareMedia();
  const th = corpusFile("talking_head", m);
  const mo = corpusFile("motion", m);
  const sc = corpusFile("speech_clean", m);
  const sn = corpusFile("speech_noisy", m);
  const mu = corpusFile("music", m);
  const out: Record<string, Record<string, unknown>> = {};
  const v = (n: string) => join(DIR, n);

  log("video variants");
  const loopIn = (f: string) => ["-stream_loop", "3", "-i", f, "-ss", "4", "-t", "15"];
  await ff([...loopIn(th), "-c:v", "libvpx", "-b:v", "1500k", v("th_vp8_1500k.webm")]);
  await ff([
    ...loopIn(th),
    "-vf",
    "scale=320:180",
    "-c:v",
    "libvpx",
    "-b:v",
    "300k",
    v("th_vp8_300k_180p.webm"),
  ]);
  await ff([
    ...loopIn(mo),
    "-vf",
    "scale=320:180,fps=15",
    "-c:v",
    "libvpx",
    "-b:v",
    "150k",
    v("mo_vp8_150k_15fps.webm"),
  ]);
  for (const [name, ref] of [
    ["th_vp8_1500k", th],
    ["th_vp8_300k_180p", th],
    ["mo_vp8_150k_15fps", mo],
  ] as const) {
    const r = await scoreVideo(ref, v(`${name}.webm`), join(WORK, name));
    out[name] = {
      vmaf: r.vmaf_mean,
      vmaf_p5: r.vmaf_p5,
      psnr_y: r.psnr_y,
      ssim: r.ssim,
      frames: r.frames_scored,
      skipped: r.alignment.skipped,
      unreadable: r.alignment.unreadable,
    };
  }

  log("speech variants (Opus via libopus)");
  const aloop = (f: string) => ["-stream_loop", "2", "-i", f, "-ss", "3.3", "-t", "40"];
  await ff([
    ...aloop(sc),
    "-c:a",
    "libopus",
    "-b:a",
    "32k",
    "-application",
    "voip",
    v("speech_opus32k.webm"),
  ]);
  await ff([...aloop(sc), "-c:a", "libopus", "-b:a", "8k", "-application", "voip", v("speech_opus8k.webm")]);
  await ff([
    ...aloop(sc),
    "-af",
    "aresample=8000,aresample=48000",
    "-c:a",
    "libopus",
    "-b:a",
    "32k",
    v("speech_nb.webm"),
  ]);
  for (const name of ["speech_opus32k", "speech_opus8k", "speech_nb"]) {
    const s = await scoreSpeech(sc, v(`${name}.webm`), join(WORK, name));
    out[name] = { pesq_wb: s.pesq_wb, pesq_min: s.pesq_wb_min, segments: s.segments, corr: s.corr };
  }
  const sn32 = v("speech_noisy_opus32k.webm");
  await ff([...aloop(sn), "-c:a", "libopus", "-b:a", "32k", sn32]);
  out.speech_noisy_vs_clean = { pesq_wb: (await scoreSpeech(sc, sn32, join(WORK, "noisy"))).pesq_wb };

  log("DNSMOS (clean vs noisy vs denoised)");
  const den = v("speech_noisy_afftdn.wav");
  await ff(["-i", sn, "-af", "afftdn=nr=20:nf=-40", den]);
  for (const [name, f] of [
    ["dnsmos_clean", sc],
    ["dnsmos_noisy", sn],
    ["dnsmos_noisy_afftdn", den],
  ] as const) {
    const d = await dnsmos(f, join(WORK, name));
    out[name] = { sig: d.sig, bak: d.bak, ovrl: d.ovrl };
  }

  log("music variants");
  await ff([
    ...aloop(mu),
    "-c:a",
    "libopus",
    "-b:a",
    "96k",
    "-application",
    "audio",
    v("music_opus96k.webm"),
  ]);
  await ff([
    ...aloop(mu),
    "-c:a",
    "libopus",
    "-b:a",
    "16k",
    "-application",
    "voip",
    v("music_opus16k_voip.webm"),
  ]);
  for (const name of ["music_opus96k", "music_opus16k_voip"]) {
    const s = await scoreMusic(mu, v(`${name}.webm`), join(WORK, name));
    out[name] = { snr_db: s.snr_db, lsd_db: s.lsd_db, segments: s.segments, corr: s.corr };
  }

  const n = (k: string, f: string) => Number(out[k]?.[f]);
  const checks: [string, boolean][] = [
    ["VMAF 1500k > 300k@180p", n("th_vp8_1500k", "vmaf") > n("th_vp8_300k_180p", "vmaf")],
    ["VMAF 1500k ≥ 80", n("th_vp8_1500k", "vmaf") >= 80],
    ["no skipped frames at 30 fps", n("th_vp8_1500k", "skipped") === 0],
    ["15 fps → ~half the reference frames skipped", n("mo_vp8_150k_15fps", "skipped") > 100],
    ["PESQ opus32k > opus8k", n("speech_opus32k", "pesq_wb") > n("speech_opus8k", "pesq_wb")],
    ["PESQ opus32k ≥ 4.0", n("speech_opus32k", "pesq_wb") >= 4.0],
    ["PESQ narrowband < wideband", n("speech_nb", "pesq_wb") < n("speech_opus32k", "pesq_wb")],
    ["PESQ noisy-vs-clean < clean", n("speech_noisy_vs_clean", "pesq_wb") < n("speech_opus32k", "pesq_wb")],
    ["DNSMOS BAK clean > noisy", n("dnsmos_clean", "bak") > n("dnsmos_noisy", "bak")],
    ["DNSMOS BAK denoised > noisy", n("dnsmos_noisy_afftdn", "bak") > n("dnsmos_noisy", "bak")],
    ["music SNR 96k > 16k voip", n("music_opus96k", "snr_db") > n("music_opus16k_voip", "snr_db")],
    ["music LSD 96k < 16k voip", n("music_opus96k", "lsd_db") < n("music_opus16k_voip", "lsd_db")],
  ];
  const fmt = (x: unknown) =>
    typeof x === "number" ? (Number.isInteger(x) ? String(x) : x.toFixed(3)) : String(x);
  for (const [k, row] of Object.entries(out))
    console.log(
      `${k.padEnd(24)} ${Object.entries(row)
        .map(([a, b]) => `${a}=${fmt(b)}`)
        .join("  ")}`,
    );
  console.log("");
  for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (checks.some(([, ok]) => !ok)) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
