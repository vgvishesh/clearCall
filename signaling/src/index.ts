import { ROOM_ID_RE } from "@clearcall/protocol";

export { Room } from "./room.ts";

export interface Env {
  ROOM: DurableObjectNamespace<import("./room.ts").Room>;
  ASSETS: Fetcher;
  /** Optional Cloudflare Realtime TURN credentials (secrets). Without them, STUN only. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return Response.json({ ok: true });

    const m = url.pathname.match(/^\/api\/room\/([^/]+)$/);
    if (m) {
      const roomId = m[1]!;
      if (!ROOM_ID_RE.test(roomId)) return new Response("bad room id", { status: 400 });
      if (request.headers.get("Upgrade") !== "websocket")
        return new Response("expected websocket", { status: 426 });
      return env.ROOM.getByName(roomId).fetch(request);
    }
    if (url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
