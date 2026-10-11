#!/usr/bin/env bash
# Fast gate. usage: verify.sh [--lint-only] [area...]   areas: protocol web signaling e2e quality harness
# With no areas: derive from files changed vs main (or HEAD).
source "$(dirname "$0")/lib.sh"
lint_only=0; [[ "${1:-}" == --lint-only ]] && { lint_only=1; shift; }
areas=("$@")
if ((${#areas[@]}==0)); then
  base=$(git -C "$ROOT" merge-base HEAD main 2>/dev/null || git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)
  changed=$( { [[ -n "$base" ]] && git -C "$ROOT" diff --name-only "$base"; git -C "$ROOT" ls-files -o -m --exclude-standard; } | sort -u)
  for a in protocol web signaling e2e quality; do grep -q "^$a/" <<<"$changed" && areas+=("$a"); done
  grep -Eq '^(\.claude/hooks/|scripts/)' <<<"$changed" && areas+=(harness)
fi
((${#areas[@]})) || { echo "verify: nothing to check"; exit 0; }
rc=0
pkg() { # area -> run lint/typecheck/test if the package exists
  local a=$1; [[ -f "$ROOT/$a/package.json" ]] || { echo "  ($a not scaffolded — skipped)"; return 0; }
  ensure_deps
  run_logged "$a-lint" "$ROOT/node_modules/.bin/biome" check --colors=off "$ROOT/$a" || rc=1
  ((lint_only)) && return 0
  (cd "$ROOT/$a" && run_logged "$a-typecheck" pnpm run --if-present typecheck) || rc=1
  (cd "$ROOT/$a" && run_logged "$a-test" pnpm run --if-present test) || rc=1
}
for a in "${areas[@]}"; do
  say "verify $a"
  case $a in
    protocol|web|signaling|quality) pkg "$a" ;;
    e2e)     pkg e2e ;;  # e2e unit-level checks only (lint/typecheck); full runs via `make e2e`
    harness) run_logged hook-tests "$ROOT/scripts/test-hooks.sh" || rc=1 ;;
  esac
done
((rc==0)) && say "verify: green" || echo "verify: RED" >&2
exit $rc
