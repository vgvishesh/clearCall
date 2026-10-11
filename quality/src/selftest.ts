/**
 * Lab self-test without the app: one Chromium fed with the reference media (exactly like a lab participant),
 * an in-page RTCPeerConnection loopback (real libwebrtc encode → decode, video capped at `kbps`), MediaRecorder on
 * the received stream (same recording path as the QA hook), then the real scorers. Proves capture → WebRTC →
 * recording → alignment → VMAF/PESQ/DNSMOS end-to-end. Writes quality/reports/<ts>-selftest/.
 *
 *   pnpm --filter @clearcall/quality lab --selftest [--seconds 20] [--kbps 1000] [--rec-kbps 8000] [--vcodec vp9]
 *        [--scale 2] [--fps 15] [--warmup 6]
 * --scale/--fps = scaleResolutionDownBy/maxFramerate (policy ladder rungs); --warmup = seconds of call before recording
 * starts (skips the congestion-control ramp so a bitrate point measures that bitrate). sent_kbps is over the recording.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dnsmos, scoreSpeech } from "./audio.ts";
import { Peer } from "./peers.ts";
import { corpusFile, prepareMedia } from "./prepare-media.ts";
import { CACHE_DIR, ensureDir, log, REPORTS_DIR, timestamp } from "./util.ts";
import { scoreVideo } from "./video.ts";

declare global {
  interface Window {
    __selftestBlob?: Blob;
  }
}

const pick = (o: Record<string, unknown> | undefined, keys: string[]) =>
  Object.fromEntries(keys.map((k) => [k, o?.[k]]));

export interface SelftestOptions {
  seconds: number;
  /** WebRTC video maxBitrate (kbps). */
  kbps: number;
  appUrl: string;
  /** MediaRecorder video bitrate (kbps) — the recording is a second lossy generation; keep it far above `kbps`. */
  recKbps?: number;
  /** Force the WebRTC video codec (vp8|vp9|h264|av1); default = browser order. */
  vcodec?: string;
  /** RTCRtpEncodingParameters.scaleResolutionDownBy (1 = source 360p). */
  scale?: number;
  /** RTCRtpEncodingParameters.maxFramerate. */
  fps?: number;
  /** Seconds of call before recording starts. */
  warmup?: number;
}

export async function selftest(o: SelftestOptions): Promise<number> {
  const recKbps = o.recKbps ?? 8000;
  const media = await prepareMedia();
  const video = corpusFile("talking_head", media);
  const audio = corpusFile("speech_clean", media);
  const out = ensureDir(join(REPORTS_DIR, `${timestamp()}-selftest`));
  const peer = await Peer.launch({ label: "self", name: "Self", media: { video, audio } });
  try {
    // Any secure-context document works; prefer the dev server origin, fall back to about:blank.
    await peer.page.goto(`${o.appUrl}/api/health`).catch(() => peer.page.goto("about:blank"));
    log(`loopback call for ${o.seconds} s at ${o.kbps} kbps video`);
    const info = await peer.page.evaluate(
      async ({ seconds, kbps, recKbps, vcodec, scale, fps, warmup }) => {
        const local = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          video: { width: 640, height: 360, frameRate: 30 },
        });
        const a = new RTCPeerConnection();
        const b = new RTCPeerConnection();
        a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
        b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
        const remote = new MediaStream();
        const gotTracks = new Promise<void>((res) => {
          b.ontrack = (e) => {
            remote.addTrack(e.track);
            if (remote.getTracks().length === 2) res();
          };
        });
        for (const t of local.getTracks()) {
          const tx = a.addTransceiver(t, { direction: "sendonly", streams: [local] });
          if (t.kind === "video" && vcodec) {
            const all = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
            const want = all.filter((c) => c.mimeType.toLowerCase() === `video/${vcodec}`);
            if (!want.length) throw new Error(`codec ${vcodec} not available`);
            tx.setCodecPreferences([...want, ...all.filter((c) => !want.includes(c))]);
          }
        }
        await a.setLocalDescription();
        await b.setRemoteDescription(a.localDescription!);
        await b.setLocalDescription();
        await a.setRemoteDescription(b.localDescription!);
        const vs = a.getSenders().find((s) => s.track?.kind === "video")!;
        const p = vs.getParameters();
        p.encodings[0]!.maxBitrate = kbps * 1000;
        if (scale > 1) p.encodings[0]!.scaleResolutionDownBy = scale;
        if (fps > 0) p.encodings[0]!.maxFramerate = fps;
        await vs.setParameters(p);
        await gotTracks;
        // Audio must be pulled by a sink for the receive pipeline to run in headless Chromium.
        const el = document.createElement("audio");
        el.srcObject = remote;
        el.muted = true;
        await el.play().catch(() => {});
        await new Promise((r) => setTimeout(r, warmup * 1000));
        // Inline snapshots (no named helper): tsx/esbuild keepNames would inject `__name`, undefined in the page.
        const s0 = { bytes: 0, enc: 0, frames: 0, t: performance.now() };
        (await a.getStats()).forEach((x) => {
          if (x.type === "outbound-rtp" && x.kind === "video")
            Object.assign(s0, {
              bytes: x.bytesSent,
              enc: x.totalEncodeTime ?? 0,
              frames: x.framesEncoded ?? 0,
            });
        });
        const rec = new MediaRecorder(remote, {
          mimeType: "video/webm;codecs=vp8,opus",
          videoBitsPerSecond: recKbps * 1000,
          audioBitsPerSecond: 256_000,
        });
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => chunks.push(e.data);
        rec.start(1000);
        await new Promise((r) => setTimeout(r, seconds * 1000));
        const stopped = new Promise((r) => (rec.onstop = r)); // before stop(): onstop may fire during getStats
        rec.stop();
        const s1 = { bytes: 0, enc: 0, frames: 0, t: performance.now() };
        (await a.getStats()).forEach((x) => {
          if (x.type === "outbound-rtp" && x.kind === "video")
            Object.assign(s1, {
              bytes: x.bytesSent,
              enc: x.totalEncodeTime ?? 0,
              frames: x.framesEncoded ?? 0,
            });
        });
        await stopped;
        const window_ = {
          kbps: ((s1.bytes - s0.bytes) * 8) / (s1.t - s0.t),
          encode_ms: s1.frames > s0.frames ? ((s1.enc - s0.enc) * 1000) / (s1.frames - s0.frames) : null,
          fps: ((s1.frames - s0.frames) * 1000) / (s1.t - s0.t),
        };
        window.__selftestBlob = new Blob(chunks, { type: "video/webm" });
        const stats: Record<string, Record<string, unknown>> = {};
        (await b.getStats()).forEach((s) => {
          if (s.type === "inbound-rtp") stats[s.kind] = s;
        });
        const sa = await a.getStats();
        sa.forEach((s) => {
          if (s.type === "outbound-rtp")
            stats[`out-${s.kind}`] = { ...s, codec: s.codecId ? sa.get(s.codecId)?.mimeType : undefined };
        });
        const settings = local.getVideoTracks()[0]!.getSettings();
        return { size: window.__selftestBlob.size, stats, settings, window: window_ };
      },
      {
        seconds: o.seconds,
        kbps: o.kbps,
        recKbps,
        vcodec: o.vcodec?.toLowerCase() ?? "",
        scale: o.scale ?? 1,
        fps: o.fps ?? 0,
        warmup: o.warmup ?? 0,
      },
    );
    const b64 = await peer.page.evaluate(async () => {
      const bytes = new Uint8Array(await window.__selftestBlob!.arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const rec = join(out, "loopback.webm");
    writeFileSync(rec, Buffer.from(b64, "base64"));
    log(`recorded ${info.size} bytes; capture ${JSON.stringify(info.settings)}`);
    await peer.close();

    const work = join(CACHE_DIR, "work", "selftest");
    const v = await scoreVideo(video, rec, join(work, "video"));
    const s = await scoreSpeech(audio, rec, join(work, "speech"));
    const d = await dnsmos(rec, join(work, "dnsmos"));
    const result = {
      kbps_cap: o.kbps,
      rec_kbps: recKbps,
      vcodec: o.vcodec ?? "default",
      scale: o.scale ?? 1,
      fps_cap: o.fps ?? null,
      warmup: o.warmup ?? 0,
      window: info.window,
      seconds: o.seconds,
      capture: info.settings,
      video: v,
      speech: s,
      dnsmos: d,
      stats: info.stats,
    };
    writeFileSync(join(out, "selftest.json"), JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify(
        {
          kbps_cap: o.kbps,
          rec_kbps: recKbps,
          vcodec: o.vcodec ?? "default",
          sent: pick(info.stats["out-video"], [
            "codec",
            "encoderImplementation",
            "frameHeight",
            "framesPerSecond",
            "qualityLimitationReason",
          ]),
          scale: o.scale ?? 1,
          fps_cap: o.fps ?? null,
          warmup: o.warmup ?? 0,
          sent_kbps: Math.round(info.window.kbps),
          sent_fps: Math.round(info.window.fps * 10) / 10,
          encode_ms: info.window.encode_ms,
          vmaf: v.vmaf_mean,
          vmaf_p5: v.vmaf_p5,
          frames: v.frames_scored,
          delivery: v.alignment.delivery_ratio,
          unreadable: v.alignment.unreadable,
          pesq_wb: s.pesq_wb,
          dnsmos: d,
          out,
        },
        null,
        1,
      ),
    );
    // Sanity floor: an uncongested loopback at ≥ 500 kbps must look and sound good.
    const ok =
      (o.kbps < 500 || v.vmaf_mean > 60) &&
      s.pesq_wb > 3 &&
      v.alignment.unreadable / (v.frames_scored || 1) < 0.2;
    log(ok ? "selftest PASS" : "selftest FAIL");
    return ok ? 0 : 1;
  } catch (e) {
    console.error(e instanceof Error ? e.stack : e);
    await peer.close();
    return 1;
  }
}
