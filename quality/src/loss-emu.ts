/**
 * Receiver-side audio packet-loss EMULATION for when netem (Docker) is unavailable — `lab --emulate-loss <pct>`.
 *
 * Every received audio RTP payload passes an RTCRtpScriptTransform (installed by a Playwright init script on each
 * `track` event) that drops frames with the same Gilbert-Elliott model netem uses (mean burst 2 packets, seeded per
 * participant → identical loss pattern across variants). Frames are dropped after depacketization and before NetEq,
 * so concealment / Opus in-band FEC / RED recovery behave as for real loss (FEC and RED payloads are split by NetEq
 * on insertion, by RTP timestamp).
 * Differences from real loss (noted in the report): no delay/jitter, video is not affected, RTCP does not see the
 * loss — so the sender's Opus encoder is told the loss rate via the libwebrtc field trial
 * `WebRTC-Audio-OpusMinPacketLossRate` (in production it learns it from RTCP receiver reports).
 * Needs `bypassCSP` (the app's CSP forbids Blob workers); lab-only.
 */
import type { Page } from "@playwright/test";
import { gilbertParams } from "./netem.ts";

export interface LossEmulation {
  initScript: string;
  chromiumArgs: string[];
  note: string;
}

/** Worker body (string): Gilbert-Elliott drop of encoded audio frames. Exported for tests. */
export const WORKER_SRC = `
let stats = { frames: 0, dropped: 0 };
onrtctransform = (ev) => {
  const t = ev.transformer;
  const { p, r, seed } = t.options;
  let x = seed >>> 0 || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  let bad = false;
  t.readable.pipeThrough(new TransformStream({
    transform(frame, ctl) {
      bad = bad ? rnd() >= r : rnd() < p;
      stats.frames++;
      if (bad) { stats.dropped++; return; }
      ctl.enqueue(frame);
    },
  })).pipeTo(t.writable);
};
onmessage = () => postMessage(stats);
`;

export function lossEmulation(lossPct: number, seed: number, burst = 2): LossEmulation {
  const { p, r } = gilbertParams(lossPct, burst);
  const initScript = `(() => {
    const P = window.RTCPeerConnection;
    if (!P || typeof RTCRtpScriptTransform !== "function") { window.__labLossEmu = { error: "no RTCRtpScriptTransform" }; return; }
    const url = URL.createObjectURL(new Blob([${JSON.stringify(WORKER_SRC)}], { type: "text/javascript" }));
    const emu = { workers: [], error: null };
    window.__labLossEmu = emu;
    let n = 0;
    const attach = (receiver) => {
      if (!receiver || receiver.track?.kind !== "audio" || receiver.transform) return;
      try {
        const w = new Worker(url);
        emu.workers.push(w);
        receiver.transform = new RTCRtpScriptTransform(w, { p: ${p}, r: ${r}, seed: ${seed} * 7919 + (n++) });
      } catch (err) { emu.error = String(err); }
    };
    // Attach on 'track' AND after every description is applied (the event alone missed one side's receivers).
    for (const m of ["setRemoteDescription", "setLocalDescription"]) {
      const orig = P.prototype[m];
      P.prototype[m] = function (...a) {
        return orig.apply(this, a).then((v) => {
          for (const r of this.getReceivers()) attach(r);
          return v;
        });
      };
    }
    window.RTCPeerConnection = function (...a) {
      const pc = new P(...a);
      pc.addEventListener("track", (e) => attach(e.receiver));
      return pc;
    };
    window.RTCPeerConnection.prototype = P.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, P);
  })();`;
  return {
    initScript,
    chromiumArgs: [`--force-fieldtrials=WebRTC-Audio-OpusMinPacketLossRate/Enabled-${Math.round(lossPct)}/`],
    note: `audio loss EMULATED (receiver-side encoded-frame drop, Gilbert ${lossPct}% mean burst ${burst}, seed ${seed}); no delay/jitter, video unaffected; encoder loss estimate forced via WebRTC-Audio-OpusMinPacketLossRate=${Math.round(lossPct)}`,
  };
}

/** Realized drop statistics summed over the page's emulation workers (null if emulation is not active). */
export async function lossEmuStats(
  page: Page,
): Promise<{ frames: number; dropped: number; error: string | null } | null> {
  return page
    .evaluate(async () => {
      const emu = (window as unknown as { __labLossEmu?: { workers: Worker[]; error: string | null } })
        .__labLossEmu;
      if (!emu) return null;
      const all = await Promise.all(
        (emu.workers ?? []).map(
          (w) =>
            new Promise<{ frames: number; dropped: number }>((res) => {
              w.onmessage = (e) => res(e.data as { frames: number; dropped: number });
              w.postMessage(0);
              setTimeout(() => res({ frames: 0, dropped: 0 }), 2000);
            }),
        ),
      );
      return {
        frames: all.reduce((a, b) => a + b.frames, 0),
        dropped: all.reduce((a, b) => a + b.dropped, 0),
        error: emu.error ?? null,
      };
    })
    .catch(() => null);
}
