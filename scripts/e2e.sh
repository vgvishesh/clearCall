#!/usr/bin/env bash
# Shared Maestro flows run on both platforms. usage: e2e.sh [flow-file-or-dir]
source "$(dirname "$0")/lib.sh"
need_scaffold quality/e2e "Maestro flows"
have maestro || fail "maestro missing (make doctor)"
target="${1:-$ROOT/quality/e2e}"
for p in ios android; do
  say "maestro on $p"; run_logged "e2e-$p" maestro --platform "$p" test --format junit --output "$LOGS/e2e-$p.xml" "$target"
done
