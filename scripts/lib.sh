# Shared helpers. Source me.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/.claude/state/logs"; mkdir -p "$LOGS"
IOS_SCHEME="${IOS_SCHEME:-BetterApp}"
IOS_BUNDLE_ID="${IOS_BUNDLE_ID:-com.example.clearcall}"
IOS_SIM="${IOS_SIM:-iPhone 17}"
ANDROID_APP_ID="${ANDROID_APP_ID:-com.example.clearcall}"
ANDROID_AVD="${ANDROID_AVD:-betterapp_api36}"
[[ -n "${ANDROID_HOME:-}" ]] || { [[ -d "$HOME/Library/Android/sdk" ]] && export ANDROID_HOME="$HOME/Library/Android/sdk"; } || true
[[ -n "${ANDROID_HOME:-}" ]] && export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

say()  { printf '\033[1m▸ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
# Exit 0 with a notice when a component hasn't been created yet, so hooks never block on missing scaffolding.
need_scaffold() { [[ -e "$ROOT/$1" ]] || { echo "  ($2 not scaffolded yet — skipped; see docs/PLAN.md M1)"; exit 0; }; }
# Run a command, keep the full log, print only what an agent needs: errors/warnings + tail.
run_logged() {
  local name="$1"; shift; local log="$LOGS/$name.log"
  if "$@" >"$log" 2>&1; then echo "  ✓ $name"; return 0; fi
  echo "  ✗ $name failed — full log: ${log#$ROOT/}" >&2
  grep -E "error:|warning: .*error|FAILED|Failed|failed|Exception|e: |✗|\*\* BUILD FAILED|Test Case .* failed" "$log" | grep -v "^\s*$" | head -40 >&2 || true
  echo "  --- last 15 lines ---" >&2; tail -15 "$log" >&2
  return 1
}
