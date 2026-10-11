#!/usr/bin/env bash
# Fast gate. usage: verify.sh [--lint-only] [area...]   areas: ios android signaling protocol quality harness
# With no areas: derive from files changed vs HEAD (or everything if no git history yet).
source "$(dirname "$0")/lib.sh"
lint_only=0; [[ "${1:-}" == --lint-only ]] && { lint_only=1; shift; }
areas=("$@")
if ((${#areas[@]}==0)); then
  if git -C "$ROOT" rev-parse HEAD >/dev/null 2>&1; then
    changed=$( { git -C "$ROOT" diff --name-only HEAD; git -C "$ROOT" ls-files -o --exclude-standard; } | sort -u)
  else changed=$(git -C "$ROOT" ls-files -o --exclude-standard); fi
  for a in ios android signaling protocol quality; do grep -q "^$a/" <<<"$changed" && areas+=("$a"); done
  grep -Eq '^(\.claude/hooks/|scripts/)' <<<"$changed" && areas+=(harness)
fi
((${#areas[@]})) || { echo "verify: nothing to check"; exit 0; }
rc=0
for a in "${areas[@]}"; do
  say "verify $a"
  case $a in
    ios)       "$ROOT/scripts/ios.sh" lint || rc=1; ((lint_only)) || "$ROOT/scripts/ios.sh" test || rc=1 ;;
    android)   "$ROOT/scripts/android.sh" lint || rc=1; ((lint_only)) || "$ROOT/scripts/android.sh" test || rc=1 ;;
    signaling) "$ROOT/scripts/signaling.sh" lint || rc=1; ((lint_only)) || { "$ROOT/scripts/signaling.sh" typecheck && "$ROOT/scripts/signaling.sh" test; } || rc=1 ;;
    protocol)  ((lint_only)) || "$ROOT/scripts/protocol-check.sh" || rc=1 ;;
    harness)   run_logged hook-tests "$ROOT/scripts/test-hooks.sh" || rc=1 ;;
    quality)   [[ -e "$ROOT/quality/runner" ]] && { (cd "$ROOT/quality" && run_logged quality-unit uv run pytest -q runner) || rc=1; } || echo "  (quality runner not scaffolded — skipped)" ;;
  esac
done
((rc==0)) && say "verify: green" || echo "verify: RED" >&2
exit $rc
