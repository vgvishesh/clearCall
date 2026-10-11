#!/usr/bin/env bash
# usage: dev.sh start|stop|status — local stack: built web assets served by the worker (wrangler dev) on $DEV_PORT.
source "$(dirname "$0")/lib.sh"
need_scaffold signaling/package.json "signaling Worker"
pidf="$ROOT/.claude/state/dev.pid"; log="$LOGS/dev-server.log"
healthy() { curl -sf "http://localhost:$DEV_PORT/api/health" >/dev/null 2>&1; }
case "${1:-start}" in
  start)
    ensure_deps
    run_logged web-build pnpm --filter @clearcall/web build
    if healthy; then echo "  ✓ dev server already running on :$DEV_PORT (assets rebuilt)"; exit 0; fi
    (cd "$ROOT/signaling" && nohup pnpm exec wrangler dev --port "$DEV_PORT" --inspector-port "$((DEV_PORT + 1000))" --ip 0.0.0.0 </dev/null >"$log" 2>&1 & echo $! >"$pidf"; disown) </dev/null >/dev/null 2>&1
    for _ in $(seq 1 60); do healthy && { echo "  ✓ http://localhost:$DEV_PORT  (log: ${log#$ROOT/})"; exit 0; }; sleep 1; done
    tail -30 "$log" >&2; fail "dev server didn't become healthy" ;;
  stop)
    [[ -f "$pidf" ]] && { pkill -P "$(cat "$pidf")" 2>/dev/null; kill "$(cat "$pidf")" 2>/dev/null; rm -f "$pidf"; }
    lsof -ti tcp:"$DEV_PORT" | xargs kill 2>/dev/null || true; echo "  ✓ stopped" ;;
  status) healthy && echo "up on :$DEV_PORT" || echo down ;;
esac
