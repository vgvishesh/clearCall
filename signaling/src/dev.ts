import { DEV_LOG_MAX_BYTES, type DevConfig, type DevLogBatch, parseDevLogBatch } from "@clearcall/protocol";

/**
 * Dev-only telemetry (`DEV_TELEMETRY === "1"`, local `wrangler dev` only): clients POST their structured logs
 * and stats samples, which we print into the dev-server log interleaved with the Worker's own lines.
 * Disabled → 404, indistinguishable from an unknown route.
 */
export async function handleDev(request: Request, env: { DEV_TELEMETRY?: string }, path: string) {
  if (env.DEV_TELEMETRY !== "1") return notFound();
  if (path === "/api/dev/config") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return Response.json({ telemetry: true } satisfies DevConfig, {
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (path === "/api/dev/log") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (declared > DEV_LOG_MAX_BYTES) return new Response("too large", { status: 413 });
    const body = await request.arrayBuffer();
    if (body.byteLength > DEV_LOG_MAX_BYTES) return new Response("too large", { status: 413 });
    const batch = parseDevLogBatch(new TextDecoder().decode(body));
    if (!batch) return new Response("bad batch", { status: 400 });
    for (const line of formatBatch(batch)) console.log(line);
    return new Response(null, { status: 204 });
  }
  return notFound();
}

/** Short peer label: peerId prefix, or the whole `lobby-xxxx` label (truncated). */
const peerLabel = (peer: string) => (peer.startsWith("lobby-") ? peer.slice(0, 12) : peer.slice(0, 6));

/** Keys that must never reach logs even if a client forgets to strip them. */
const REDACT = new Set(["name", "sdp", "data", "secret", "credential", "username"]);

/** One-line JSON with privacy-sensitive keys redacted at any depth (nested `data` blobs included). */
export function compact(value: unknown): string {
  return JSON.stringify(value, (k, v) => (k !== "" && REDACT.has(k) ? "[redacted]" : v));
}

export function formatBatch(batch: DevLogBatch): string[] {
  const who = peerLabel(batch.peer);
  const lines: string[] = [];
  for (const e of batch.entries) {
    const data = e.data ? ` ${compact(e.data)}` : "";
    lines.push(`[client ${who}] ${e.level} ${e.scope} ${e.msg}${data}`);
  }
  for (const s of batch.samples ?? []) lines.push(`[stats ${who}] ${compact(s)}`);
  return lines;
}

const notFound = () => new Response("not found", { status: 404 });
const methodNotAllowed = (allow: string) =>
  new Response("method not allowed", { status: 405, headers: { Allow: allow } });
