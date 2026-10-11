/**
 * SDP munging — only Opus fmtp parameters, nothing structural.
 *
 * Mode-dependent (plan "Media details (B)"): voice `useinbandfec=1;usedtx=1`, music `useinbandfec=1;usedtx=0`,
 * both with `maxaveragebitrate=128000` advertised (actual send bitrate is set via setParameters).
 *
 * Applied to (a) our local offer/answer before setLocalDescription — our receive preference — and (b) the remote
 * description before setRemoteDescription — libwebrtc configures OUR Opus encoder (DTX/FEC) from the remote's fmtp,
 * so this is what makes our own sending follow our mode.
 */
import type { AudioMode } from "./types.ts";

export type FmtpParams = Record<string, string | number>;

export function opusParamsFor(mode: AudioMode): FmtpParams {
  return { useinbandfec: 1, usedtx: mode === "voice" ? 1 : 0, maxaveragebitrate: 128_000 };
}

function eolOf(sdp: string): string {
  return sdp.includes("\r\n") ? "\r\n" : "\n";
}

function splitLines(sdp: string): string[] {
  return sdp.split(/\r?\n/);
}

/** Parse "a=b;c=d" (fmtp parameter list) preserving order. */
export function parseFmtp(params: string): [string, string][] {
  return params
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      return i < 0
        ? ([p, ""] as [string, string])
        : ([p.slice(0, i).trim(), p.slice(i + 1).trim()] as [string, string]);
    });
}

function formatFmtp(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join(";");
}

/** Payload types of Opus in an SDP (any m=audio section). */
export function opusPayloadTypes(sdp: string): string[] {
  const pts: string[] = [];
  for (const line of splitLines(sdp)) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (m && !pts.includes(m[1]!)) pts.push(m[1]!);
  }
  return pts;
}

/** Set (add or replace) the given Opus fmtp parameters; other parameters and lines are untouched. */
export function mungeOpusFmtp(sdp: string, params: FmtpParams): string {
  if (!sdp) return sdp;
  const eol = eolOf(sdp);
  const lines = splitLines(sdp);
  const trailing = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  const pts = new Set(opusPayloadTypes(sdp));
  if (pts.size === 0) return sdp;

  const apply = (existing: string): string => {
    const pairs = parseFmtp(existing);
    for (const [k, v] of Object.entries(params)) {
      const i = pairs.findIndex(([pk]) => pk.toLowerCase() === k.toLowerCase());
      if (i >= 0) pairs[i] = [pairs[i]![0], String(v)];
      else pairs.push([k, String(v)]);
    }
    return formatFmtp(pairs);
  };

  const out: string[] = [];
  const seenFmtp = new Set<string>();
  // First pass: rewrite existing fmtp lines.
  for (const line of lines) {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (m && pts.has(m[1]!)) {
      // fmtp lines are per m-section; key by position of the preceding m= line to allow repeated PTs.
      seenFmtp.add(`${out.filter((l) => l.startsWith("m=")).length}:${m[1]}`);
      out.push(`a=fmtp:${m[1]} ${apply(m[2]!)}`);
    } else out.push(line);
  }
  // Second pass: add missing fmtp lines right after the rtpmap line.
  const result: string[] = [];
  let section = 0;
  for (const line of out) {
    if (line.startsWith("m=")) section++;
    result.push(line);
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (m && !seenFmtp.has(`${section}:${m[1]}`)) result.push(`a=fmtp:${m[1]} ${apply("")}`);
  }
  return result.join(eol) + (trailing ? eol : "");
}

/** The Opus fmtp parameters of the first Opus payload type (for tests/diagnostics). */
export function readOpusFmtp(sdp: string): Record<string, string> | null {
  const pt = opusPayloadTypes(sdp)[0];
  if (!pt) return null;
  for (const line of splitLines(sdp)) {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (m && m[1] === pt) return Object.fromEntries(parseFmtp(m[2]!));
  }
  return {};
}

/** Media kinds of every m-line in order, e.g. ["audio","video","application"]. */
export function mLineKinds(sdp: string): string[] {
  return splitLines(sdp)
    .filter((l) => l.startsWith("m="))
    .map((l) => l.slice(2).split(" ")[0] ?? "");
}

/**
 * The `o=` session id (RFC 8866 §5.2): stable for the lifetime of one RTCPeerConnection and unique per pc, so a
 * different id on a remote offer means the remote side replaced its pc. null if absent/unparseable.
 */
export function sdpSessionId(sdp: string | undefined | null): string | null {
  if (!sdp) return null;
  const o = splitLines(sdp).find((l) => l.startsWith("o="));
  return o?.split(" ")[1] ?? null;
}

/** The whole `o=` line (session id + version): equal ⇔ the very same description from the same pc. */
export function sdpOrigin(sdp: string | undefined | null): string | null {
  if (!sdp) return null;
  return splitLines(sdp).find((l) => l.startsWith("o=")) ?? null;
}

/** Convenience used by peer-session: munge a description for our current mode (rollback/empty pass through). */
export function mungeDescription<T extends { type: RTCSdpType; sdp?: string | undefined }>(
  desc: T,
  mode: AudioMode,
): T {
  if (desc.type === "rollback" || !desc.sdp) return desc;
  return { ...desc, sdp: mungeOpusFmtp(desc.sdp, opusParamsFor(mode)) };
}
