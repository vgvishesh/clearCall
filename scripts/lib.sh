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
# Host-wide FIFO lock for CPU-sensitive measurement runs (quality lab, diag) across all worktrees.
# Parallel measurements on this shared host corrupt each other's numbers, so they queue — fairly: each waiter
# takes a ticket and runs only when it holds the oldest live ticket (a sweep can't starve other agents).
LAB_LOCK="${LAB_LOCK:-$HOME/.cache/clearcall/lab.lock}"
LAB_QUEUE="${LAB_QUEUE:-$(dirname "$LAB_LOCK")/lab.queue}"
# PID of the current (sub)shell; portable to macOS bash 3.2, which has no $BASHPID.
# (Not via $(...): bash 3.2 forks a command-substitution subshell, so $PPID there is that short-lived child.)
_self_pid_into() { # $1 = variable name
  if [[ -n "${BASHPID:-}" ]]; then eval "$1=\$BASHPID"; return; fi
  local f; f=$(mktemp); sh -c 'echo $PPID' > "$f"; read -r "$1" < "$f"; rm -f "$f"
}
_lab_release() {
  [[ -n "${_lab_ticket:-}" ]] && rm -f "$_lab_ticket"
  [[ "$(cat "$LAB_LOCK/pid" 2>/dev/null)" == "${_lab_pid:-x}" ]] && rm -rf "$LAB_LOCK"
  return 0
}
with_lab_lock() {
  mkdir -p "$LAB_QUEUE"
  # Per-process pid (not $$, which is the parent's inside subshells) for liveness checks and ownership.
  _self_pid_into _lab_pid
  _lab_ticket="$LAB_QUEUE/$(date +%s)$(printf '%05d' $RANDOM).$_lab_pid"
  echo "$* (${ROOT##*/})" > "$_lab_ticket"
  trap _lab_release EXIT INT TERM
  local waited=0 t first owner
  while :; do
    for t in "$LAB_QUEUE"/*; do [[ -e "$t" ]] || continue; kill -0 "${t##*.}" 2>/dev/null || rm -f "$t"; done
    first=$(ls "$LAB_QUEUE" | sort | head -1)
    if [[ "$LAB_QUEUE/$first" == "$_lab_ticket" ]] && mkdir "$LAB_LOCK" 2>/dev/null; then break; fi
    owner=$(cat "$LAB_LOCK/pid" 2>/dev/null || true)
    if [[ -n "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$LAB_LOCK"; continue; fi
    if ((waited % 30 == 0)); then echo "  … queued for lab lock ($(ls "$LAB_QUEUE" | wc -l | tr -d ' ') waiting; running: $(cat "$LAB_LOCK/what" 2>/dev/null))" >&2; fi
    sleep 2; waited=$((waited + 2))
    if ((waited > 7200)); then fail "lab lock wait > 2 h"; fi
  done
  echo "$_lab_pid" > "$LAB_LOCK/pid"; echo "$* (${ROOT##*/})" > "$LAB_LOCK/what"
  local rc=0
  "$@" || rc=$?
  _lab_release; trap - EXIT INT TERM
  return $rc
}
