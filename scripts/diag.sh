#!/usr/bin/env bash
# usage: diag.sh N=<participants> DURATION=<s> [--fault drop-signaling@20s] [--netem --profile <name>] [--url …]
# Headless N-party call on the local dev stack → quality/reports/diag-<ts>/ (logs, stats timelines, console,
# screenshots, CPU, worker.log slice, summary.md with anomalies). Exit 1 on hard anomalies.
source "$(dirname "$0")/lib.sh"
need_scaffold quality/package.json "quality lab"
ensure_deps
"$ROOT/scripts/dev.sh" start
cd "$ROOT/quality" && with_lab_lock pnpm exec tsx src/diag.ts --url "http://localhost:$DEV_PORT" "$@"
