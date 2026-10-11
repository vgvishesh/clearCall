#!/usr/bin/env bash
# Stop: run `make verify` for areas touched this session; block stopping while red (max 3 blocks, then hand to the owner).
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
in=$(cat); sid=$(jq -r '.session_id // "nosession"' <<<"$in")
[[ "${CLEARCALL_SKIP_STOP_VERIFY:-}" == 1 ]] && exit 0
list="$ROOT/.claude/state/changed-$sid.txt"; count="$ROOT/.claude/state/stopblocks-$sid"
[[ -s "$list" ]] || exit 0
fail_out=""; rc=0
# Entries are "<checkout>|<relative path>"; verify each checkout (main tree or worktree) for its touched areas.
while IFS= read -r top; do
  [[ -d "$top" ]] || continue
  areas=$( { grep -F "$top|" "$list" | cut -d'|' -f2 | cut -d/ -f1 | grep -Ex 'web|signaling|protocol|quality|e2e'
             grep -F "$top|" "$list" | cut -d'|' -f2 | grep -Eq '^(\.claude/hooks/|scripts/)' && echo harness; } | sort -u | tr '\n' ' ')
  [[ -n "$areas" ]] || continue
  [[ -x "$top/scripts/verify.sh" ]] || continue
  if ! out=$("$top/scripts/verify.sh" $areas 2>&1); then rc=1; fail_out+="[$top] areas: $areas"$'\n'"$(sed 's/\x1b\[[0-9;]*m//g' <<<"$out" | tail -50)"$'\n'; fi
done < <(cut -d'|' -f1 "$list" | sort -u)
if ((rc==0)); then rm -f "$list" "$count"; exit 0; fi
n=$(( $(cat "$count" 2>/dev/null || echo 0) + 1 )); echo $n > "$count"
if (( n > 3 )); then
  jq -n --arg m "verify still red after 3 attempts. Stopping so the owner can look. Logs: .claude/state/logs/" '{systemMessage:$m}'; exit 0
fi
jq -n --arg r "make verify is RED (attempt $n/3). Fix the root cause — don't skip tests or weaken checks.
$fail_out" '{decision:"block",reason:$r}'
