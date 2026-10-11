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
