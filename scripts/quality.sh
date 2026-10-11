#!/usr/bin/env bash
# usage: quality.sh <profile>|all   → quality/reports/<timestamp>-<profile>/report.{json,md}; exit 1 on any threshold breach.
source "$(dirname "$0")/lib.sh"
need_scaffold quality/runner "quality lab runner (M2)"
cd "$ROOT/quality"
profiles=("$1"); [[ "$1" == all ]] && profiles=($(ls profiles | sed 's/\.yaml$//'))
rc=0; for p in "${profiles[@]}"; do say "quality: $p"; uv run runner/run.py --profile "profiles/$p.yaml" --thresholds thresholds.yaml || rc=1; done
exit $rc
