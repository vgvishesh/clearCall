#!/usr/bin/env bash
# usage: quality.sh <profile>|all → quality/reports/<ts>-<profile>/report.{json,md}; exit 1 on any threshold breach.
source "$(dirname "$0")/lib.sh"
need_scaffold quality/package.json "quality lab"
"$ROOT/scripts/dev.sh" start
cd "$ROOT/quality" && pnpm run lab -- --profile "$1"
