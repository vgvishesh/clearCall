/**
 * Codec preferences.
 * - Video: power-efficient (hardware) encoders first, decided once per session via
 *   `navigator.mediaCapabilities.encodingInfo({type:"webrtc"})` (battery/thermals on phones). Then the software order
 *   for the mesh tier (`tierVideoPreference`, ADR-0005 W4 evidence): quality per bit where 1–2 encodes run, cheapest
 *   encoder where many do. API missing (Firefox) → tier order only. `?vcodec=` (lab) forces one codec first.
 * - Audio: Opus first. RED (`audio/red`) only when the `red` flag is on (OFF by default; the quality lab flips it
 *   with `?red=1` and decides from `3g_lossy` data). When off, RED is removed so it is never negotiated.
 */
import type { Logger } from "./log.ts";
import { errInfo, nullLogger } from "./log.ts";
import type { AudioTuning } from "./media.ts";

export interface CodecLike {
  mimeType: string;
  clockRate: number;
  channels?: number;
  sdpFmtpLine?: string;
}

export interface MediaCapabilitiesLike {
  encodingInfo(cfg: unknown): Promise<{ supported: boolean; smooth?: boolean; powerEfficient?: boolean }>;
}

/** Codecs probed for hardware encode (tie order among power-efficient ones). */
export const VIDEO_PREFERENCE = ["video/VP9", "video/H264", "video/AV1", "video/VP8"] as const;

/** Mesh tier of a participant count, as far as the codec choice is concerned (ADR-0005 tiers). */
export function codecTier(participants: number): 2 | 4 | 10 {
  return participants <= 2 ? 2 : participants <= 4 ? 4 : 10;
}

/**
 * Software-encoder order per tier (W4 V3 bake-off, headless Chromium, ADR-0005):
 * - 1–2: AV1 first. Same bitrate, VMAF 85.5 vs VP9 83.4 / VP8 83.1 (good_wifi, 3 runs each); CPU/peer 59 % vs 52 % / 43 %.
 * - 3–4: VP8 first. AV1 is +3.9 VMAF but +59 % CPU (88 % vs 55 % of a core per peer, 3 encodes); VP9 is worse than
 *   VP8 on both. Software AV1 ×3 on a mid-range phone is the thermal risk this tier can't take.
 * - 5–10: VP8 first, lowest CPU (54 % vs 66–67 % for AV1/VP9 at N=6); at N=10 AV1/VP9 saturated the host.
 * OpenH264 (software H264) is last or near-last everywhere: 79.0 vs 83.6–86.2 at 1500 kbps, 36 VMAF at 270p/400k.
 * Hardware H264/VP9/AV1 (power-efficient) still goes first via chooseVideoCodecOrder — unmeasured in the headless lab.
 */
export function tierVideoPreference(participants: number): readonly string[] {
  return TIER_ORDER[codecTier(participants)];
}

const TIER_ORDER: Record<2 | 4 | 10, readonly string[]> = {
  2: ["video/AV1", "video/VP9", "video/VP8", "video/H264"],
  4: ["video/VP8", "video/AV1", "video/VP9", "video/H264"],
  10: ["video/VP8", "video/VP9", "video/H264", "video/AV1"],
};

const FORCEABLE: Record<string, string> = {
  vp8: "video/VP8",
  vp9: "video/VP9",
  h264: "video/H264",
  av1: "video/AV1",
};

/** `?vcodec=` override → a one-codec preference (others stay as fallback). null = not forced / unknown. */
export function forcedVideoOrder(flag: string | undefined): string[] | null {
  const mime = flag ? FORCEABLE[flag.toLowerCase()] : undefined;
  return mime ? [mime] : null;
}

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
 * The power-efficient (hardware) video encoders of this device, in VIDEO_PREFERENCE order — they go before the tier's
 * software order. null when the capabilities API is missing/failing or nothing is power-efficient.
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
    const efficient = infos.filter((i) => i.supported && i.powerEfficient).map((i) => i.mime);
    log.info("video codecs: power-efficient first", { efficient });
    return efficient.length ? efficient : null;
  } catch (e) {
    log.warn("mediaCapabilities failed", errInfo(e));
    return null;
  }
}

/** Full video mime order: forced / power-efficient codecs first, then the tier's software order. */
export function videoOrderFor(first: readonly string[] | null, participants: number): string[] {
  return [...(first ?? []), ...tierVideoPreference(participants)];
}

export interface CodecPrefs {
  /** Lab override of the video start bitrate (`?vstart=<kbps>`, 0 = libwebrtc default); absent = policy. */
  videoStartKbps?: number | undefined;
  red: boolean;
  /** Mimes before the tier order: `?vcodec=` forced codec, else power-efficient ones; null = tier order only. */
  videoOrder: string[] | null;
  /** Lab overrides for Opus bitrate/DTX/FEC (URL flags); absent = defaults. */
  audio?: AudioTuning | undefined;
}

/** Apply preferences to a transceiver before an offer/answer is created. Never throws. */
export function applyCodecPreferences(
  transceiver: RTCRtpTransceiver,
  kind: "audio" | "video",
  capabilities: { codecs: CodecLike[] } | null | undefined,
  prefs: CodecPrefs,
  log: Logger = nullLogger,
  participants = 2,
): void {
  if (!capabilities?.codecs?.length || typeof transceiver.setCodecPreferences !== "function") return;
  let ordered: CodecLike[];
  if (kind === "audio") ordered = audioCodecOrder(capabilities.codecs, prefs.red);
  else ordered = orderCodecs(capabilities.codecs, videoOrderFor(prefs.videoOrder, participants));
  try {
    transceiver.setCodecPreferences(ordered as RTCRtpCodec[]);
  } catch (e) {
    log.warn("setCodecPreferences failed", { kind, ...errInfo(e) });
  }
}
