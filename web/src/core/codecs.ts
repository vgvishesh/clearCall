/**
 * Codec preferences.
 * - Video: prefer a power-efficient (hardware) encoder: VP9 → H264 → VP8, decided once per session via
 *   `navigator.mediaCapabilities.encodingInfo({type:"webrtc"})`. API missing (Firefox) → browser default order.
 * - Audio: Opus first. RED (`audio/red`) only when the `red` flag is on (OFF by default; the quality lab flips it
 *   with `?red=1` and decides from `3g_lossy` data). When off, RED is removed so it is never negotiated.
 */
import type { Logger } from "./log.ts";
import { errInfo, nullLogger } from "./log.ts";

export interface CodecLike {
  mimeType: string;
  clockRate: number;
  channels?: number;
  sdpFmtpLine?: string;
}

export interface MediaCapabilitiesLike {
  encodingInfo(cfg: unknown): Promise<{ supported: boolean; smooth?: boolean; powerEfficient?: boolean }>;
}

export const VIDEO_PREFERENCE = ["video/VP9", "video/H264", "video/VP8"] as const;

const lower = (s: string) => s.toLowerCase();

/** Stable reorder: codecs whose mimeType is in `order` come first in that order; everything else keeps its place after. */
export function orderCodecs<T extends CodecLike>(codecs: readonly T[], order: readonly string[]): T[] {
  const rank = (c: T) => {
    const i = order.findIndex((m) => lower(m) === lower(c.mimeType));
    return i < 0 ? order.length : i;
  };
  return codecs
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);
}

export function audioCodecOrder<T extends CodecLike>(codecs: readonly T[], red: boolean): T[] {
  if (red) return orderCodecs(codecs, ["audio/red", "audio/opus"]);
  return orderCodecs(
    codecs.filter((c) => lower(c.mimeType) !== "audio/red"),
    ["audio/opus"],
  );
}

/**
 * Decide the video codec mime order for this device. Resolves to null when we should leave the browser default
 * (no capabilities API, or nothing useful learned).
 */
export async function chooseVideoCodecOrder(
  available: readonly CodecLike[] | null | undefined,
  mediaCapabilities: MediaCapabilitiesLike | undefined,
  log: Logger = nullLogger,
  probe = { width: 1280, height: 720, bitrate: 1_500_000, framerate: 30 },
): Promise<string[] | null> {
  if (!available?.length || !mediaCapabilities?.encodingInfo) return null;
  const present = VIDEO_PREFERENCE.filter((m) => available.some((c) => lower(c.mimeType) === lower(m)));
  if (present.length === 0) return null;
  try {
    const infos = await Promise.all(
      present.map(async (mime) => {
        const codec = available.find((c) => lower(c.mimeType) === lower(mime));
        const contentType = codec?.sdpFmtpLine ? `${mime};${codec.sdpFmtpLine}` : mime;
        try {
          const info = await mediaCapabilities.encodingInfo({
            type: "webrtc",
            video: { contentType, ...probe },
          });
          return { mime, supported: info.supported, powerEfficient: info.powerEfficient === true };
        } catch {
          return { mime, supported: false, powerEfficient: false };
        }
      }),
    );
    if (!infos.some((i) => i.supported)) return null;
    const efficient = infos.filter((i) => i.supported && i.powerEfficient).map((i) => i.mime);
    const supported = infos.filter((i) => i.supported && !i.powerEfficient).map((i) => i.mime);
    const order = [...efficient, ...supported];
    log.info("video codec order", { order, efficient });
    return order;
  } catch (e) {
    log.warn("mediaCapabilities failed", errInfo(e));
    return null;
  }
}

export interface CodecPrefs {
  red: boolean;
  videoOrder: string[] | null;
}

/** Apply preferences to a transceiver before an offer/answer is created. Never throws. */
export function applyCodecPreferences(
  transceiver: RTCRtpTransceiver,
  kind: "audio" | "video",
  capabilities: { codecs: CodecLike[] } | null | undefined,
  prefs: CodecPrefs,
  log: Logger = nullLogger,
): void {
  if (!capabilities?.codecs?.length || typeof transceiver.setCodecPreferences !== "function") return;
  let ordered: CodecLike[];
  if (kind === "audio") ordered = audioCodecOrder(capabilities.codecs, prefs.red);
  else if (prefs.videoOrder?.length) ordered = orderCodecs(capabilities.codecs, prefs.videoOrder);
  else return;
  try {
    transceiver.setCodecPreferences(ordered as RTCRtpCodec[]);
  } catch (e) {
    log.warn("setCodecPreferences failed", { kind, ...errInfo(e) });
  }
}
