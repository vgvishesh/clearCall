/**
 * Lab self-test without the app: one Chromium fed with the reference media (exactly like a lab participant),
 * an in-page RTCPeerConnection loopback (real libwebrtc encode → decode, video capped at `kbps`), MediaRecorder on
 * the received stream (same recording path as the QA hook), then the real scorers. Proves capture → WebRTC →
 * recording → alignment → VMAF/PESQ/DNSMOS end-to-end. Writes quality/reports/<ts>-selftest/.
 *
 *   pnpm --filter @clearcall/quality lab --selftest [--seconds 20] [--kbps 1000]
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

export async function selftest(o: { seconds: number; kbps: number; appUrl: string }): Promise<number> {
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
      async ({ seconds, kbps }) => {
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
        for (const t of local.getTracks()) a.addTrack(t, local);
        await a.setLocalDescription();
        await b.setRemoteDescription(a.localDescription!);
        await b.setLocalDescription();
        await a.setRemoteDescription(b.localDescription!);
        const vs = a.getSenders().find((s) => s.track?.kind === "video")!;
        const p = vs.getParameters();
        p.encodings[0]!.maxBitrate = kbps * 1000;
        await vs.setParameters(p);
        await gotTracks;
        // Audio must be pulled by a sink for the receive pipeline to run in headless Chromium.
        const el = document.createElement("audio");
        el.srcObject = remote;
        el.muted = true;
        await el.play().catch(() => {});
        const rec = new MediaRecorder(remote, {
          mimeType: "video/webm;codecs=vp8,opus",
          videoBitsPerSecond: 8_000_000,
          audioBitsPerSecond: 256_000,
        });
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => chunks.push(e.data);
        rec.start(1000);
        await new Promise((r) => setTimeout(r, seconds * 1000));
        rec.stop();
        await new Promise((r) => (rec.onstop = r));
        window.__selftestBlob = new Blob(chunks, { type: "video/webm" });
        const stats: Record<string, unknown> = {};
        (await b.getStats()).forEach((s) => {
          if (s.type === "inbound-rtp") stats[s.kind] = s;
        });
        (await a.getStats()).forEach((s) => {
          if (s.type === "outbound-rtp") stats[`out-${s.kind}`] = s;
        });
        const settings = local.getVideoTracks()[0]!.getSettings();
        return { size: window.__selftestBlob.size, stats, settings };
      },
      { seconds: o.seconds, kbps: o.kbps },
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
