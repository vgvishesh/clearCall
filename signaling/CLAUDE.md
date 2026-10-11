# signaling/ — Cloudflare Worker + Room Durable Object
Load `signaling-worker`. Serves `web/dist` and `/api/*` (health, room WebSocket). Free plan, hibernation API, server never reads relayed blobs. Tests: Vitest workers pool with real WebSockets.
