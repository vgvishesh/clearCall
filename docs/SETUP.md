# Setup

Clearcall is a web app (PWA) plus one Cloudflare Worker. Everything fits Cloudflare's free tier.
`make doctor` checks the toolchain. (Native iOS/Android plans are parked in `docs/paused-native/`.)

## Toolchain
- **Node ≥ 22** and **pnpm 10** (`corepack enable`), then `make install`.
- Playwright browsers for E2E: `pnpm --filter @clearcall/e2e exec playwright install chromium firefox webkit`.
- Quality lab only: `ffmpeg` (with libvmaf) and `uv` (`brew install ffmpeg uv`); Docker Desktop for shaped-network
  (netem) profiles.

## Run locally
```
make dev      # builds web/ and runs the Worker at http://localhost:8787 (app + signaling)
make verify   # format, lint, typecheck, unit tests
make e2e      # multi-browser call tests against the local Worker
```
Camera/mic need a secure context: `localhost` works; for phones on your LAN use `make tunnel` (HTTPS URL).

## Deploy your own (free)
1. Cloudflare account (free) → `cd signaling && npx wrangler login`.
2. `make deploy-staging` → prints `https://clearcall-staging.<your-subdomain>.workers.dev`.
3. Open it, **Start a call**, share the link. Production: `scripts/deploy.sh production` (worker name `clearcall`).

That's a complete deployment: calls connect directly between devices (STUN). Nothing else is required.

## TURN (optional)
**What it is.** Most devices sit behind a router (NAT). STUN lets two devices discover their public addresses and
connect directly — that works for most calls. Strict NATs (some mobile carriers, CGNAT), office/school firewalls and
some hotel Wi-Fi block direct connections; those calls **fail to connect** without a relay. A TURN server is that
relay: both devices connect *out* to it (allowed even on strict networks, including TLS on port 443) and it forwards
the media. Media stays end-to-end encrypted (DTLS-SRTP), so the relay only sees ciphertext. The browser uses TURN only
when a direct route fails; Clearcall's code never forces it.

**Cost.** Cloudflare Realtime TURN: 1,000 GB/month free, then pay-as-you-go. Only relayed calls count.

**How Clearcall uses it.** The Worker holds a TURN key as two secrets and mints short-lived (12 h) TURN credentials
for each call (`signaling/src/ice.ts`), rate-limited per IP. No secrets reach browsers or the repo. Without the
secrets the Worker hands out STUN only — the app works exactly as before.

**Enable it**
1. Cloudflare dashboard → **Realtime** → **TURN Server** → **Create**. Copy the **Turn Token ID** and the
   **API Token** (shown once).
2. `make turn-setup ENV=staging` — prompts for both values and stores them as Worker secrets
   (`TURN_KEY_ID`, `TURN_KEY_API_TOKEN`). Takes effect immediately; no redeploy.
3. `make turn-check URL=https://clearcall-staging.<your-subdomain>.workers.dev` — checks `/api/health` reports
   `"turn":true`, then runs a relay-only 2-party call (`?relay=1`) that can only connect through TURN.

Disable: `scripts/turn.sh remove staging`. Local dev: copy `signaling/.dev.vars.example` to `signaling/.dev.vars`.
Debug any deployment: open a call with `?relay=1` to force TURN; `?qa=1` then `__clearcall.stats()` shows each
pair's `candidateType` (`relay` = via TURN, `host`/`srflx` = direct).

## Real devices
At least one iPhone and one Android phone (cameras, echo cancellation, hardware codecs and mobile networks can't be
validated in emulators). Headphones and a speaker to test Music mode and echo.

## Secrets
Never in git: `signaling/.dev.vars`, Cloudflare tokens. Agents are blocked from reading them (`.claude/hooks/`).
