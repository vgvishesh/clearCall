#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit): format, record the change for the Stop gate, fast single-file lint, contextual reminders.
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
in=$(cat)
path=$(jq -r '.tool_input.file_path // ""' <<<"$in"); sid=$(jq -r '.session_id // "nosession"' <<<"$in")
[[ -n "$path" && -f "$path" ]] || exit 0
# Work relative to the checkout that contains the file (agents may run in git worktrees).
top=$(git -C "$(dirname "$path")" rev-parse --show-toplevel 2>/dev/null || echo "$ROOT")
rel="${path#$top/}"
mkdir -p "$ROOT/.claude/state"; echo "$top|$rel" >> "$ROOT/.claude/state/changed-$sid.txt"
biome="$top/node_modules/.bin/biome"
problems=""
case "$path" in
  *.ts|*.tsx|*.js|*.mjs|*.json|*.jsonc|*.css)
    if [[ -x "$biome" ]]; then
      (cd "$top" && "$biome" check --write --no-errors-on-unmatched "$path" >/dev/null 2>&1) || true
      problems=$(cd "$top" && "$biome" check --no-errors-on-unmatched --colors=off "$path" 2>&1 | grep -vE '^(Checked|The number of diagnostics)' | head -30)
      grep -qE '━━|×|error' <<<"$problems" || problems=""
    fi ;;
esac
if [[ -n "$problems" ]]; then echo "Lint issues in $rel (fix before moving on):"$'\n'"$problems" >&2; exit 2; fi
ctx=""
case "$rel" in
  protocol/*) ctx="You changed the signaling contract. Follow the protocol-change skill: bump PROTOCOL_VERSION if not additive, update fixtures, then signaling/ and web/, and run make protocol-check." ;;
  web/src/core/types.ts) ctx="You changed the UI↔engine contract (CallController). Update FakeCallController and the real controller together, and every UI usage." ;;
esac
[[ -n "$ctx" ]] && jq -n --arg c "$ctx" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$c}}'
exit 0
