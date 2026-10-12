/**
 * Mesh bandwidth policy (ADR-0005). Pure functions: inputs → per-connection encode caps.
 *
 * | Participants (incl. self) | Max encode | Max bitrate / peer | fps |
 * | 1–2                        | 720p       | 1500 kbps          | 30  |
 * | 3–4                        | 360p       | 600 / 800 kbps     | 30  |
 * | 5–10                       | 180p       | 150 kbps           | 15  |
 *
 * 3–4 has two send levels per pair (ADR-0008): base 600 kbps, high 800 kbps when the link has headroom (adaptive.ts).
 * Further capped by the receiver's `view` message (rendered tile height in device px; 0 = not visible → pause),
 * and our own hidden tab makes us report view 0 to everyone (they pause sending to us).
 */
import type { SendLevel } from "./adaptive.ts";
import type { AudioMode } from "./types.ts";

export interface Tier {
  maxHeight: number;
  maxBitrate: number;
  maxFramerate: number;
}

export function tierFor(participants: number): Tier {
  if (participants <= 2) return { maxHeight: 720, maxBitrate: 1_500_000, maxFramerate: 30 };
  if (participants <= 4) return { maxHeight: 360, maxBitrate: 600_000, maxFramerate: 30 };
  return { maxHeight: 180, maxBitrate: 150_000, maxFramerate: 15 };
}

/** Encode ladder (short-side px → bitrate at 30 fps that looks clean for typical talking-head content). */
export const LADDER: readonly { height: number; bitrate: number }[] = [
  { height: 180, bitrate: 250_000 },
  { height: 270, bitrate: 400_000 },
  { height: 360, bitrate: 600_000 },
  { height: 540, bitrate: 1_000_000 },
  { height: 720, bitrate: 1_500_000 },
];

/** Smallest ladder rung that covers `h` device px (a tile never gets upscaled video). */
export function rungFor(h: number): { height: number; bitrate: number } {
  for (const r of LADDER) if (r.height >= h) return r;
  return LADDER[LADDER.length - 1]!;
}

/**
 * Tier 3–4 `high` level (ADR-0008, owner decision 2026-10-12): 800 kbps instead of 600 when the pair's link has
 * headroom. Replaces the tier cap and the 360p rung together (W4 cap knee: VMAF 68 → 75, received 270p → 360p).
 */
export const TIER4_HIGH_BITRATE = 800_000;

/** Only the 3–4 tier has two send levels. */
export function hasLevels(participants: number): boolean {
  return participants >= 3 && participants <= 4;
}

export interface VideoPolicyInput {
  /** Participants in the room including ourselves. */
  participants: number;
  /** Receiver-reported rendered height (device px) of our video. undefined = not reported yet; 0 = not visible. */
  viewHeight?: number | undefined;
  /** Short side of our capture in px (e.g. 720 for 1280×720). undefined → assume 720. */
  sourceShortSide?: number | undefined;
  /** Adaptive send level; only the 3–4 tier at its full 360p target uses it. undefined = base. */
  level?: SendLevel | undefined;
}

export interface VideoEncodeCaps {
  /** false = pause this encoding (receiver doesn't render us). */
  active: boolean;
  /** Target short side after scaling. */
  targetHeight: number;
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
  /**
   * Set only by the high level: "maintain-resolution". libwebrtc clears its quality-scaler restriction when the
   * preference changes, so a sender that dropped to ~270p at 600 kbps returns to 360p at 800 (an 800 cap alone
   * leaves it at 270p — lab, ADR-0008). Absent = browser default ("balanced"; restored when leaving high).
   */
  degradationPreference?: "maintain-resolution";
}

/** Whether the high level would change this encode: 3–4 tier and the receiver wants the full 360p target. */
export function levelEligible(participants: number, targetHeight: number): boolean {
  return hasLevels(participants) && targetHeight >= tierFor(participants).maxHeight;
}

export function videoPolicy(input: VideoPolicyInput): VideoEncodeCaps {
  const tier = tierFor(Math.max(1, input.participants));
  const view = input.viewHeight;
  const active = view === undefined || view > 0;
  const viewRung = view !== undefined && view > 0 ? rungFor(view) : undefined;
  const targetHeight = Math.min(tier.maxHeight, viewRung?.height ?? tier.maxHeight);
  const high = input.level === "high" && levelEligible(input.participants, targetHeight);
  // High never changes the scale (Firefox's H264 sender stalls on scale changes): bitrate + degradation preference.
  const maxBitrate = high ? TIER4_HIGH_BITRATE : Math.min(tier.maxBitrate, rungFor(targetHeight).bitrate);
  const source = input.sourceShortSide && input.sourceShortSide > 0 ? input.sourceShortSide : 720;
  const scaleResolutionDownBy = Math.max(1, Math.round((source / targetHeight) * 100) / 100);
  return {
    active,
    targetHeight,
    maxBitrate,
    maxFramerate: tier.maxFramerate,
    scaleResolutionDownBy,
    ...(high ? { degradationPreference: "maintain-resolution" as const } : {}),
  };
}

/**
 * Initial bandwidth estimate for a new connection (`x-google-start-bitrate`, kbps). libwebrtc starts at 300 kbps,
 * which makes the encoder drop a 720p capture to a lower resolution and climb back slowly. Starting at the tier's
 * cap lets the first frames go out at the target size; congestion control still backs off within ~1 s if the
 * link can't carry it (W4 V2 data in ADR-0005).
 */
export function videoStartBitrateKbps(participants: number, override?: number): number | null {
  if (override !== undefined) return override > 0 ? override : null;
  return Math.round(tierFor(Math.max(1, participants)).maxBitrate / 1000);
}

export const AUDIO_BITRATE: Record<AudioMode, number> = { voice: 32_000, music: 96_000 };

export function audioPolicy(
  mode: AudioMode,
  tuning: { voiceBitrate?: number; musicBitrate?: number } = {},
): { maxBitrate: number } {
  const override = mode === "voice" ? tuning.voiceBitrate : tuning.musicBitrate;
  return { maxBitrate: override ?? AUDIO_BITRATE[mode] };
}

/** What we tell a peer about how big we render its video. Our hidden tab ⇒ 0 (pause). */
export function viewToReport(tileHeightDevicePx: number, hidden: boolean): number {
  if (hidden || !Number.isFinite(tileHeightDevicePx) || tileHeightDevicePx <= 0) return 0;
  return Math.min(4320, Math.round(tileHeightDevicePx));
}

/**
 * Whether a new view report differs enough from the last one sent to be worth a message:
 * only rung changes and visible⇄hidden transitions matter to the sender's policy.
 */
export function viewChanged(prev: number | undefined, next: number): boolean {
  if (prev === undefined) return true;
  if ((prev === 0) !== (next === 0)) return true;
  if (next === 0) return false;
  return rungFor(prev).height !== rungFor(next).height;
}

type WithDegradation = RTCRtpSendParameters & { degradationPreference?: string };

/**
 * Read-modify-write of RTCRtpSendParameters for video (Firefox requires the encodings length unchanged).
 * Returns null when nothing changes (skip the setParameters call).
 * degradationPreference is only touched by the high level (and restored to "balanced" when leaving it); everywhere
 * else it stays at the browser default — some engines throw on it (the caller retries without it).
 */
export function mergeVideoEncoding(
  params: RTCRtpSendParameters,
  caps: VideoEncodeCaps,
): RTCRtpSendParameters | null {
  const encodings = params.encodings?.length ? params.encodings : [{}];
  const e0 = encodings[0]!;
  const next = {
    active: caps.active,
    maxBitrate: caps.maxBitrate,
    maxFramerate: caps.maxFramerate,
    scaleResolutionDownBy: caps.scaleResolutionDownBy,
  };
  const current = (params as WithDegradation).degradationPreference;
  const wantDp = caps.degradationPreference ?? (current && current !== "balanced" ? "balanced" : undefined);
  const dpChange = wantDp !== undefined && wantDp !== current;
  const same =
    params.encodings?.length &&
    !dpChange &&
    e0.active === next.active &&
    e0.maxBitrate === next.maxBitrate &&
    e0.maxFramerate === next.maxFramerate &&
    e0.scaleResolutionDownBy === next.scaleResolutionDownBy;
  if (same) return null;
  const out: WithDegradation = { ...params, encodings: [{ ...e0, ...next }, ...encodings.slice(1)] };
  if (dpChange) out.degradationPreference = wantDp;
  return out;
}

/** The same parameters without a degradationPreference change (fallback for engines that reject it). */
export function withoutDegradation(
  next: RTCRtpSendParameters,
  prev: RTCRtpSendParameters,
): RTCRtpSendParameters {
  const out: WithDegradation = { ...next };
  const p = (prev as WithDegradation).degradationPreference;
  if (p === undefined) delete out.degradationPreference;
  else out.degradationPreference = p;
  return out;
}

export function mergeAudioEncoding(
  params: RTCRtpSendParameters,
  maxBitrate: number,
): RTCRtpSendParameters | null {
  const encodings = params.encodings?.length ? params.encodings : [{}];
  const e0 = encodings[0]!;
  if (params.encodings?.length && e0.maxBitrate === maxBitrate) return null;
  return { ...params, encodings: [{ ...e0, maxBitrate }, ...encodings.slice(1)] };
}
