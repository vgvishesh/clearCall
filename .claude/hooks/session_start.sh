#!/usr/bin/env bash
# SessionStart (startup|resume|compact): inject current plan status + environment readiness as context.
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
echo "## betterApp session context"
echo "### Milestones (docs/PLAN.md)"
awk '/^\| [MW][0-9]/' "$ROOT/docs/PLAN.md" | awk -F'|' '{gsub(/^ +| +$/,"",$2);gsub(/^ +| +$/,"",$3);gsub(/^ +| +$/,"",$5); print "- "$2" "$3" — "$5}'
echo "### Open decisions"; awk '/^## Open decisions/{f=1;next} /^## /{f=0} f&&/^- /' "$ROOT/docs/PLAN.md"
echo "### Toolchain"
out=$("$ROOT/scripts/doctor.sh" 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
grep -E '✗' <<<"$out" | sed 's/^ */- BLOCKER /' || true
tail -1 <<<"$out"
grep -E '^  (iOS simulators booted|iPhone:|android:)' <<<"$out" | sed 's/^ */- /' || true
echo "Use \`make\` targets (see CLAUDE.md). If a blocker prevents a task, say so instead of working around it."
