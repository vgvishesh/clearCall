#!/usr/bin/env bash
# Stop: run `make verify` for areas touched this session; block stopping while red (max 3 blocks, then hand to the owner).
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
in=$(cat); sid=$(jq -r '.session_id // "nosession"' <<<"$in")
[[ "${BETTERAPP_SKIP_STOP_VERIFY:-}" == 1 ]] && exit 0
list="$ROOT/.claude/state/changed-$sid.txt"; count="$ROOT/.claude/state/stopblocks-$sid"
[[ -s "$list" ]] || exit 0
areas=$( { cut -d/ -f1 "$list" | grep -Ex 'ios|android|signaling|protocol|quality'; grep -Eq '^(\.claude/hooks/|scripts/)' "$list" && echo harness; } | sort -u | tr '\n' ' ')
[[ -n "$areas" ]] || { rm -f "$list"; exit 0; }
if out=$("$ROOT/scripts/verify.sh" $areas 2>&1); then rm -f "$list" "$count"; exit 0; fi
n=$(( $(cat "$count" 2>/dev/null || echo 0) + 1 )); echo $n > "$count"
clean=$(sed 's/\x1b\[[0-9;]*m//g' <<<"$out" | tail -60)
if (( n > 3 )); then
  jq -n --arg m "verify still red after 3 attempts ($areas). Stopping so the owner can look. Logs: .claude/state/logs/" '{systemMessage:$m}'; exit 0
fi
jq -n --arg r "make verify is RED for: $areas (attempt $n/3). Fix the root cause — don't skip tests or weaken checks.
$clean" '{decision:"block",reason:$r}'
