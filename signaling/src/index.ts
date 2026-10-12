import { ROOM_ID_RE } from "@clearcall/protocol";
import { handleDev } from "./dev.ts";
import { type Env, ROOM_HEADER } from "./env.ts";

export { Room } from "./room.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    // `turn` says whether TURN secrets are configured (never their values) — `make turn-check` reads it.
    if (path === "/api/health")
      return Response.json({ ok: true, turn: Boolean(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) });

    const m = path.match(/^\/api\/room\/([^/]+)$/);
    if (m) {
      const roomId = m[1]!;
      if (!ROOM_ID_RE.test(roomId)) return new Response("bad room id", { status: 400 });
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return new Response("expected websocket", { status: 426, headers: { Upgrade: "websocket" } });
      const headers = new Headers(request.headers);
      headers.set(ROOM_HEADER, roomId);
      return env.ROOM.getByName(roomId).fetch(new Request(request.url, { headers }));
    }
    if (path.startsWith("/api/dev/")) return handleDev(request, env, path);
    if (path.startsWith("/api/")) return new Response("not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
