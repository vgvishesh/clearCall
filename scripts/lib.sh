# Shared helpers. Source me.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/.claude/state/logs"; mkdir -p "$LOGS"
DEV_PORT="${DEV_PORT:-8787}"

say()  { printf '\033[1m▸ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
# Exit 0 with a notice when a component hasn't been created yet, so hooks never block on missing scaffolding.
need_scaffold() { [[ -e "$ROOT/$1" ]] || { echo "  ($2 not scaffolded yet — skipped; see docs/PLAN.md)"; exit 0; }; }
ensure_deps() { [[ -d "$ROOT/node_modules" ]] || (cd "$ROOT" && run_logged pnpm-install pnpm install --frozen-lockfile); }
# Run a command, keep the full log, print only what an agent needs: errors + tail.
run_logged() {
  local name="$1"; shift; local log="$LOGS/$name.log"
  if "$@" >"$log" 2>&1; then echo "  ✓ $name"; return 0; fi
  echo "  ✗ $name failed — full log: ${log#$ROOT/}" >&2
  grep -E "error|Error|FAIL|failed|✗|×|expected|Expected|Received|TS[0-9]{4}" "$log" | grep -v "^\s*$" | head -40 >&2 || true
  echo "  --- last 15 lines ---" >&2; tail -15 "$log" >&2
  return 1
}
# Host-wide mutex for CPU-sensitive measurement runs (quality lab, diag) across all worktrees.
# Parallel measurements on this shared host corrupt each other's numbers, so they queue instead.
LAB_LOCK="${LAB_LOCK:-$HOME/.cache/clearcall/lab.lock}"
with_lab_lock() {
  mkdir -p "$(dirname "$LAB_LOCK")"
  local waited=0
  until mkdir "$LAB_LOCK" 2>/dev/null; do
    local owner; owner=$(cat "$LAB_LOCK/pid" 2>/dev/null || true)
    if [[ -n "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$LAB_LOCK"; continue; fi  # stale lock
    ((waited % 30 == 0)) && echo "  … waiting for lab lock held by pid ${owner:-?} ($(cat "$LAB_LOCK/what" 2>/dev/null))" >&2
    sleep 2; waited=$((waited + 2))
    ((waited > 3600)) && fail "lab lock wait > 1 h"
  done
  echo $$ > "$LAB_LOCK/pid"; echo "$* (${ROOT##*/})" > "$LAB_LOCK/what"
  trap 'rm -rf "$LAB_LOCK"' EXIT
  "$@"
}
