---
name: signaling-worker
description: Develop, test and deploy the Cloudflare Worker + Durable Objects that handle signaling, presence, push relay (APNs VoIP/FCM), TURN/SFU credentials. Use for work under signaling/.
---
# signaling-worker
Load the global `durable-objects`, `wrangler` and `workers-best-practices` skills for platform details — they retrieve current Cloudflare docs.

- Stack: TypeScript, Workers, SQLite-backed Durable Objects (free plan), WebSocket **Hibernation API** (`ctx.acceptWebSocket`) so idle connections cost nothing. Vitest with `@cloudflare/vitest-pool-workers`. Biome for lint/format.
- `UserDO` (per identity public key): presence socket, mailbox for offline signaling, push tokens. `CallDO` (per call): roster, topology (mesh↔SFU), E2EE key epoch, timeouts.
- Auth: every request signed by the device key (Ed25519 over a server nonce). No passwords, no sessions to store.
- Secrets (`APNS_KEY`, `FCM_SA`, `REALTIME_APP_SECRET`, `TURN_KEY`) via `wrangler secret put` — owner runs it; locally via `.dev.vars` (agent cannot read it).
- Store the minimum: public keys, discovery hashes, push tokens. No call metadata beyond what an active call needs; TTL everything.
- `make signaling-dev` (local, `wrangler dev`), `make signaling-test`. Deploy only staging yourself: `make signaling-deploy-staging`. Production deploy asks the owner (hook-enforced).
- Free-plan budget awareness: DO requests/duration and Worker requests are capped daily — keep presence heartbeats in WebSocket auto-response (`setWebSocketAutoResponse`) so pings don't wake the DO.
