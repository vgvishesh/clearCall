#!/usr/bin/env bash
# usage: signaling.sh dev|test|lint|typecheck|deploy-staging
source "$(dirname "$0")/lib.sh"
need_scaffold signaling/package.json "signaling Worker"
cd "$ROOT/signaling"; [[ -d node_modules ]] || run_logged signaling-install pnpm install --frozen-lockfile
case "${1:-test}" in
  dev)            exec pnpm exec wrangler dev ;;
  test)           run_logged signaling-test pnpm exec vitest run ;;
  typecheck)      run_logged signaling-typecheck pnpm exec tsc --noEmit ;;
  lint)           run_logged signaling-lint pnpm exec biome check . ;;
  deploy-staging) pnpm exec wrangler deploy --env staging ;;
  *) fail "unknown: $1" ;;
esac
