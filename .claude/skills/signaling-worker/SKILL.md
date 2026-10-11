---
name: signaling-worker
description: Develop and test the Cloudflare Worker that serves the Clearcall PWA and runs the Room Durable Object (WebSocket hibernation signaling relay, presence, resume, limits, TURN credentials). Use for work under signaling/.
---
# signaling-worker
Load the global `durable-objects`, `wrangler` and `workers-best-practices` skills for current Cloudflare APIs.

- `wrangler.jsonc`: `assets.directory = "../web/dist"`, `not_found_handling = "single-page-application"`, `run_worker_first = ["/api/*"]`; DO binding `ROOM` → class `Room` with a `new_sqlite_classes` migration (free plan); envs `staging`, `production`.
- Routes: `GET /api/health` → 200 `{ok:true}`; `GET /api/room/:roomId` with `Upgrade: websocket` → `env.ROOM.getByName(roomId)`; anything else under `/api` → 404. Validate `roomId` format before touching a DO.
- Room DO: `ctx.acceptWebSocket(ws)` (hibernation), per-socket state in `ws.serializeAttachment({peerId, joinedAt, away?})`, `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"))`. On close: mark away + `ctx.storage.setAlarm(now+20s)`; `alarm()` broadcasts `peer-left` for expired peers. `resume` with the same peerId re-binds without leave/join broadcasts.
- Enforce: max 10 peers, 64 KiB messages, simple token-bucket rate limit per socket, validate every message with `@clearcall/protocol`; never parse or log `data` blobs.
- TURN: if `TURN_KEY_ID` + `TURN_KEY_API_TOKEN` secrets exist, mint credentials from Cloudflare Realtime TURN (short TTL) and include them in `welcome.iceServers`; otherwise STUN only (`stun:stun.cloudflare.com:3478`). Cache minted creds in the DO for a few minutes.
- Security headers for HTML via `web/public/_headers` (CSP, Permissions-Policy camera/microphone=self, Referrer-Policy no-referrer).
- Tests: Vitest + `@cloudflare/vitest-pool-workers` (real DO, real WebSockets): join/welcome, relay to the right peer only, room full, resume, away→alarm→peer-left, invalid messages, size/rate limits.
- `make dev` runs it locally. Deploy: staging only (`make deploy-staging`), production asks the owner.
