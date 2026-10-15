#!/usr/bin/env bash
# usage: dev.sh start|stop|status — local stack: built web assets served by the worker (wrangler dev) on $DEV_PORT.
source "$(dirname "$0")/lib.sh"
need_scaffold signaling/package.json "signaling Worker"
pidf="$ROOT/.claude/state/dev.pid"; log="$LOGS/dev-server.log"
healthy() { curl -sf "http://localhost:$DEV_PORT/api/health" >/dev/null 2>&1; }
inspector=$((DEV_PORT + 1000))
# Kill listeners on these ports that belong to THIS repo (an orphaned workerd keeps the inspector port after a crash or
# an agent's run, and the next start dies with "bind(): Address already in use"). Other projects' processes are left alone.
free_ports() {
  local port pid cwd
  for port in "$@"; do
    for pid in $(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null); do
      cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
      if [[ "$cwd" == "$ROOT"* ]]; then kill "$pid" 2>/dev/null || true
      else fail "port $port is used by another program (pid $pid, $cwd) — set DEV_PORT=<other> or stop it"; fi
    done
  done
}
case "${1:-start}" in
  start)
    ensure_deps
    run_logged web-build pnpm --filter @clearcall/web build
    # Reuse a running server only if it serves this build: wrangler's asset watcher can be off on this host, so a
    # stale server would otherwise run tests against old app code.
    if healthy && [[ "$(curl -sf "http://localhost:$DEV_PORT/")" == "$(cat "$ROOT/web/dist/index.html")" ]]; then
      echo "  ✓ dev server already running on :$DEV_PORT (serving this build)"; exit 0
    fi
    healthy && echo "  ↻ dev server on :$DEV_PORT serves an older build — restarting"
    [[ -f "$pidf" ]] && { pkill -P "$(cat "$pidf")" 2>/dev/null || true; kill "$(cat "$pidf")" 2>/dev/null || true; rm -f "$pidf"; }
    free_ports "$DEV_PORT" "$inspector"; sleep 1
    (cd "$ROOT/signaling" && nohup pnpm exec wrangler dev --port "$DEV_PORT" --inspector-port "$((DEV_PORT + 1000))" --ip 0.0.0.0 ${WRANGLER_ARGS:-} </dev/null >"$log" 2>&1 & echo $! >"$pidf"; disown) </dev/null >/dev/null 2>&1
    for _ in $(seq 1 60); do healthy && { echo "  ✓ http://localhost:$DEV_PORT  (log: ${log#$ROOT/})"; exit 0; }; sleep 1; done
    tail -30 "$log" >&2; fail "dev server didn't become healthy" ;;
  stop)
    [[ -f "$pidf" ]] && { pkill -P "$(cat "$pidf")" 2>/dev/null || true; kill "$(cat "$pidf")" 2>/dev/null || true; rm -f "$pidf"; }
    free_ports "$DEV_PORT" "$inspector"; echo "  ✓ stopped" ;;
  status) healthy && echo "up on :$DEV_PORT" || echo down ;;
esac
