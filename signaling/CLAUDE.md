# signaling/ — Cloudflare Worker + Durable Objects
Load the `signaling-worker` skill. TypeScript strict, Biome, Vitest (workers pool). `wrangler.jsonc` defines `dev`, `staging`, `production` envs.
This is the only server-side code in the project; keep it small, stateless where possible, free-tier friendly, and storing the minimum.
