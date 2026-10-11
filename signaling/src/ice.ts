import type { IceServer } from "@clearcall/protocol";

/** Always offered, with or without TURN. */
export const STUN_SERVER: IceServer = { urls: "stun:stun.cloudflare.com:3478" };
/** Lifetime of minted TURN credentials. Longer than any call we expect. */
export const TURN_TTL_SECONDS = 12 * 60 * 60;
/** How long a room reuses minted credentials (well inside the TTL). */
export const TURN_CACHE_MS = 10 * 60 * 1000;
const MINT_TIMEOUT_MS = 3000;

export const turnEndpoint = (keyId: string) =>
  `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;

export interface IceDeps {
  keyId?: string | undefined;
  apiToken?: string | undefined;
  /** ≤ 1 mint per client IP per minute (Workers rate-limit binding). Absent → no per-IP limit. */
  limiter?: RateLimit | undefined;
  /** Room-local cache (DO storage). */
  cache: { get(): CachedIce | undefined; put(v: CachedIce): void };
  fetch?: typeof fetch;
  now: number;
}

export interface CachedIce {
  iceServers: IceServer[];
  expiresAt: number;
}

export type IceOutcome = "stun-only" | "cached" | "minted" | "ip-limited" | "mint-failed";

/**
 * ICE servers for a `welcome`. STUN always; TURN when secrets are configured, minted from Cloudflare Realtime TURN
 * at most once per room per TURN_CACHE_MS and once per client IP per minute. Any failure falls back to STUN only.
 * Credentials are never logged.
 */
export async function resolveIceServers(
  deps: IceDeps,
  ip: string | undefined,
): Promise<{ iceServers: IceServer[]; outcome: IceOutcome }> {
  if (!deps.keyId || !deps.apiToken) return { iceServers: [STUN_SERVER], outcome: "stun-only" };
  const cached = deps.cache.get();
  if (cached && cached.expiresAt > deps.now) return { iceServers: cached.iceServers, outcome: "cached" };
  if (deps.limiter) {
    try {
      const { success } = await deps.limiter.limit({ key: ip ?? "unknown" });
      if (!success) return { iceServers: [STUN_SERVER], outcome: "ip-limited" };
    } catch {
      // limiter unavailable: proceed (the room cache still bounds minting)
    }
  }
  const turn = await mintTurn(deps.keyId, deps.apiToken, deps.fetch ?? fetch);
  if (!turn) return { iceServers: [STUN_SERVER], outcome: "mint-failed" };
  const iceServers = [STUN_SERVER, ...turn];
  deps.cache.put({ iceServers, expiresAt: deps.now + TURN_CACHE_MS });
  return { iceServers, outcome: "minted" };
}

/** POST generate-ice-servers; returns only the TURN entries (port 53 URLs removed: browsers block them). */
export async function mintTurn(
  keyId: string,
  apiToken: string,
  fetchImpl: typeof fetch,
): Promise<IceServer[] | null> {
  let body: unknown;
  try {
    const res = await fetchImpl(turnEndpoint(keyId), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    body = await res.json();
  } catch {
    return null;
  }
  const raw = (body as { iceServers?: unknown } | null)?.iceServers;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: IceServer[] = [];
  for (const s of list) {
    if (typeof s !== "object" || s === null) continue;
    const { urls, username, credential } = s as Record<string, unknown>;
    if (typeof username !== "string" || typeof credential !== "string") continue;
    const urlList = (Array.isArray(urls) ? urls : [urls]).filter(
      (u): u is string => typeof u === "string" && /^turns?:/.test(u) && !/:53(\?|$)/.test(u),
    );
    if (urlList.length) out.push({ urls: urlList, username, credential });
  }
  return out.length ? out : null;
}
