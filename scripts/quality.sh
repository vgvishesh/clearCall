#!/usr/bin/env bash
# usage: quality.sh <profile>|all → quality/reports/<ts>-<profile>/report.{json,md}; exit 1 on any threshold breach.
source "$(dirname "$0")/lib.sh"
need_scaffold quality/package.json "quality lab"
# --netem starts Docker containers from node (invisible to the Bash guard): apply the same run-headroom rule here.
if [[ " $* " == *" --netem "* ]]; then
  free_gb=$(df -g / 2>/dev/null | awk 'NR==2{print $4}')
  if [[ -n "$free_gb" && "$free_gb" -lt "${MIN_RUN_FREE_GB:-8}" ]]; then
    echo "✗ only ${free_gb} GB free on / (need ≥ ${MIN_RUN_FREE_GB:-8} GB for --netem runs); don't prune the owner's Docker data — report instead" >&2
    exit 2
  fi
fi
"$ROOT/scripts/dev.sh" start
cd "$ROOT/quality" && with_lab_lock pnpm run lab -- --profile "$1" "${@:2}"
