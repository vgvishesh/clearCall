import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.ts";

/** One instance per call. Stub — implemented by the signaling work package (see signaling-worker skill). */
export class Room extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }
}
