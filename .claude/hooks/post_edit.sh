#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit): format, record the change for the Stop gate, fast single-file lint, contextual reminders.
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
in=$(cat)
path=$(jq -r '.tool_input.file_path // ""' <<<"$in"); sid=$(jq -r '.session_id // "nosession"' <<<"$in")
[[ -n "$path" && -f "$path" ]] || exit 0
rel="${path#$ROOT/}"
mkdir -p "$ROOT/.claude/state"; echo "$rel" >> "$ROOT/.claude/state/changed-$sid.txt"
"$ROOT/scripts/fmt.sh" "$path" >/dev/null 2>&1 || true
problems=""
case "$path" in
  *.swift) command -v swiftlint >/dev/null && [[ -f "$ROOT/ios/.swiftlint.yml" ]] && problems=$(cd "$ROOT/ios" && swiftlint lint --quiet "$path" 2>/dev/null | grep -E 'error|warning' | head -20) ;;
  *.kt|*.kts) command -v ktlint >/dev/null && problems=$(cd "$ROOT/android" 2>/dev/null && ktlint --relative "$path" 2>/dev/null | head -20) ;;
esac
if [[ -n "$problems" ]]; then echo "Lint issues in $rel (fix before moving on):"$'\n'"$problems" >&2; exit 2; fi
ctx=""
case "$rel" in
  protocol/*) ctx="You changed the signaling contract. Follow the protocol-change skill: bump version, add/adjust fixtures, update signaling/ + ios/ + android/, run make protocol-check." ;;
  ios/*|android/*)
    other=$([[ $rel == ios/* ]] && echo android || echo ios)
    grep -q "^$other/" "$ROOT/.claude/state/changed-$sid.txt" 2>/dev/null || ctx="Parity reminder: user-facing changes in ${rel%%/*}/ need the matching change in $other/ before the feature is done." ;;
esac
[[ -n "$ctx" ]] && jq -n --arg c "$ctx" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$c}}'
exit 0
