#!/usr/bin/env bash
# usage: deploy.sh staging|production  (production asks the owner via hook)
source "$(dirname "$0")/lib.sh"
env="${1:-staging}"; ensure_deps
run_logged web-build pnpm --filter @clearcall/web build
cd "$ROOT/signaling" && pnpm exec wrangler deploy --env "$env"
