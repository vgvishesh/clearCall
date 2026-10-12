#!/usr/bin/env bash
# Optional TURN relay (Cloudflare Realtime TURN). Without it calls are STUN-only: direct P2P, which fails on strict
# NATs/firewalls (~1 in 10 calls). See docs/SETUP.md → "TURN (optional)".
#   turn.sh setup [staging|production]   prompts for the TURN key id + API token and stores them as Worker secrets
#   turn.sh check <url>                  health says turn:true, then a relay-only 2-party call must connect via TURN
#   turn.sh remove [staging|production]  deletes both secrets (back to STUN-only)
source "$(dirname "$0")/lib.sh"
cmd="${1:-}"; shift || true
case "$cmd" in
  setup)
    env="${1:-staging}"
    echo "Create a key: Cloudflare dashboard → Realtime → TURN Server → Create. Paste the values when prompted."
    cd "$ROOT/signaling"
    pnpm exec wrangler secret put TURN_KEY_ID --env "$env"
    pnpm exec wrangler secret put TURN_KEY_API_TOKEN --env "$env"
    echo "✓ TURN secrets set on env '$env' (live immediately, no redeploy needed). Verify: make turn-check URL=<your app URL>"
    ;;
  check)
    url="${1:?usage: turn.sh check <app url, e.g. https://clearcall-staging.<you>.workers.dev>}"
    url="${url%/}"
    health=$(curl -fsS "$url/api/health") || { echo "✗ $url/api/health unreachable" >&2; exit 1; }
    echo "health: $health"
    [[ "$health" == *'"turn":true'* ]] || { echo "✗ TURN not configured on $url (run: make turn-setup ENV=…)" >&2; exit 1; }
    ensure_deps
    cd "$ROOT/e2e" && CLEARCALL_URL="$url" CLEARCALL_TURN=1 \
      run_logged turn-check pnpm exec playwright test --project=chromium --no-deps tests/turn.spec.ts
    echo "✓ relay-only call connected through TURN on $url"
    ;;
  remove)
    env="${1:-staging}"; cd "$ROOT/signaling"
    pnpm exec wrangler secret delete TURN_KEY_ID --env "$env"
    pnpm exec wrangler secret delete TURN_KEY_API_TOKEN --env "$env"
    ;;
  *) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
