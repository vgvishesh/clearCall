/**
 * `window.__clearcall` (QaHook) for E2E, the quality lab and diagnostics. Installed by `createCallController()`
 * when the page has `?qa=1`.
 */
import { errInfo, type Logger, nullLogger, short } from "./log.ts";
import type { CallState, LogEntry, QaHook, QaPeerStats, QaStatsSample, TransportKind } from "./types.ts";

export interface QaSources {
  state: () => CallState;
  stats: () => Promise<QaPeerStats[]>;
  timeline: () => QaStatsSample[];
  logs: () => LogEntry[];
  transport: () => TransportKind;
  dropSignaling: () => void;
  restartIce: (participantId?: string) => void;
  killPeer: (participantId?: string) => void;
  simulateCpuOverload: () => void;
  MediaRecorder?: typeof MediaRecorder | undefined;
  log?: Logger;
}

/**
 * Recording is a second lossy generation on top of the call's encode. Chrome's default (~2.5 Mbps VP8) cost
 * ~2 VMAF at a 1.5 Mbps call (lab selftest, VP9 360p: 80.8 vs 82.9); 8 Mbps is transparent (8 vs 30 Mbps: ±0.1).
 * Audio is left at the browser default so speech/music scores stay comparable with earlier reports.
 */
export const QA_RECORDER_VIDEO_BPS = 8_000_000;

interface Recording {
  rec: MediaRecorder;
  chunks: Blob[];
  done: Promise<Blob | null>;
}

export function createQaHook(src: QaSources): QaHook {
  const log = src.log ?? nullLogger;
  const recordings = new Map<string, Recording>();

  const pickMime = (MR: typeof MediaRecorder) => {
    for (const m of ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm", "video/mp4"])
      if (typeof MR.isTypeSupported !== "function" || MR.isTypeSupported(m)) return m;
    return undefined;
  };

  return {
    state: src.state,
    stats: async () => {
      try {
        return await src.stats();
      } catch (e) {
        log.warn("qa stats failed", errInfo(e));
        return [];
      }
    },
    statsTimeline: src.timeline,
    logs: src.logs,
    transport: src.transport,
    startRecording(participantId) {
      const MR = src.MediaRecorder;
      const p = src.state().participants.find((x) => x.id === participantId);
      if (!MR || !p?.stream || recordings.has(participantId)) {
        log.warn("recording not started", {
          peer: short(participantId),
          hasRecorder: !!MR,
          hasStream: !!p?.stream,
        });
        return;
      }
      const mimeType = pickMime(MR);
      const rec = new MR(p.stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: QA_RECORDER_VIDEO_BPS,
      });
      const chunks: Blob[] = [];
      const done = new Promise<Blob | null>((resolve) => {
        rec.ondataavailable = (ev) => {
          if (ev.data.size) chunks.push(ev.data);
        };
        rec.onstop = () =>
          resolve(chunks.length ? new Blob(chunks, { type: rec.mimeType || mimeType }) : null);
        rec.onerror = () => resolve(null);
      });
      rec.start(1000);
      recordings.set(participantId, { rec, chunks, done });
      log.info("recording started", { peer: short(participantId), mimeType });
    },
    async stopRecording(participantId) {
      const r = recordings.get(participantId);
      if (!r) return null;
      recordings.delete(participantId);
      try {
        if (r.rec.state !== "inactive") r.rec.stop();
      } catch {}
      return r.done;
    },
    inject(fault, participantId) {
      log.warn("fault injected", { fault, ...(participantId ? { peer: short(participantId) } : {}) });
      if (fault === "drop-signaling") src.dropSignaling();
      else if (fault === "restart-ice") src.restartIce(participantId);
      else if (fault === "kill-peer") src.killPeer(participantId);
      else if (fault === "cpu-overload") src.simulateCpuOverload();
    },
  };
}

export function installQaHook(target: object, hook: QaHook): () => void {
  (target as { __clearcall?: QaHook }).__clearcall = hook;
  return () => {
    const t = target as { __clearcall?: QaHook };
    if (t.__clearcall === hook) delete t.__clearcall;
  };
}
