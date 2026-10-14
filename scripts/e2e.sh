#!/usr/bin/env bash
# Playwright E2E against the real worker + built assets. Extra args go to `playwright test`.
# E2E_DOCKER=1: Chromium runs in the quality lab's Docker image (Playwright run-server) instead of on this host —
# for sessions where local browsers can't launch. Chromium projects only (--project=chromium / screens).
source "$(dirname "$0")/lib.sh"
need_scaffold e2e/package.json "E2E suite"
"$ROOT/scripts/dev.sh" start
export CLEARCALL_URL="http://localhost:$DEV_PORT"
if [[ "${E2E_DOCKER:-}" == "1" ]]; then
  free_gb=$(df -g / 2>/dev/null | awk 'NR==2{print $4}')
  if [[ -n "$free_gb" && "$free_gb" -lt "${MIN_RUN_FREE_GB:-8}" ]]; then
    fail "only ${free_gb} GB free (need ≥ ${MIN_RUN_FREE_GB:-8} GB to run the browser image)"
  fi
  img="clearcall-lab-peer:1.64.0"; name="clearcall-e2e-browser"
  docker image inspect "$img" >/dev/null 2>&1 || fail "$img missing: run one netem lab session first (it builds it)"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --rm --name "$name" --shm-size 2g --add-host host.docker.internal:host-gateway \
    -p 127.0.0.1::3000 "$img" playwright run-server --port 3000 --host 0.0.0.0 --unsafe >/dev/null
  trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
  # In-container forwarder: the page loads http://localhost:$DEV_PORT (a secure context) → the host's worker.
  docker exec -d "$name" node -e "const n=require('net');n.createServer(c=>{const u=n.connect($DEV_PORT,'host.docker.internal');c.pipe(u).pipe(c);const k=()=>{c.destroy();u.destroy()};c.on('error',k);u.on('error',k)}).listen($DEV_PORT,'127.0.0.1')"
  port=$(docker port "$name" 3000 | head -1 | awk -F: '{print $NF}')
  export E2E_REMOTE_WS="ws://127.0.0.1:$port/"
  for _ in $(seq 1 30); do curl -s "http://127.0.0.1:$port/" >/dev/null 2>&1 && break; sleep 1; done
  echo "  browsers: Docker ($name, $E2E_REMOTE_WS)"
fi
cd "$ROOT/e2e" && run_logged e2e pnpm exec playwright test --reporter=line "$@"
echo "  report: e2e/playwright-report/index.html · screenshots: quality/reports/screens/"
