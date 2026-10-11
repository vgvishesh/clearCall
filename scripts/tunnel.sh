#!/usr/bin/env bash
# Expose the local dev server over HTTPS (needed for camera/mic on phones) via a Cloudflare quick tunnel. No account needed.
source "$(dirname "$0")/lib.sh"
have cloudflared || fail "brew install cloudflared"
"$ROOT/scripts/dev.sh" start
echo "Open the https://*.trycloudflare.com URL below on your phone. Ctrl-C to stop."
exec cloudflared tunnel --url "http://localhost:$DEV_PORT"
