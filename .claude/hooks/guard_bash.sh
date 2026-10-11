#!/usr/bin/env bash
# PreToolUse(Bash): deny destructive / oracle-weakening / secret-leaking commands; ask for outward-facing ones.
in=$(cat)
raw=$(jq -r '.tool_input.command // ""' <<<"$in")
hook_cwd=$(jq -r '.cwd // ""' <<<"$in")
# Drop heredoc bodies: text being written (docs, code) is not a command and must not trip the guards.
cmd=$(awk '
  d!="" { if ($0 ~ "^[ \t]*"d"[ \t]*$") d=""; next }
  { print; if (match($0, /<<-?[ \t]*["\x27]?[A-Za-z_][A-Za-z0-9_]*/)) { t=substr($0,RSTART,RLENGTH); gsub(/<<-?[ \t]*["\x27]?/,"",t); d=t } }
' <<<"$raw")
# One command segment per line, for checks that must look at a single command.
segs=$(sed -E 's/(&&|\|\||;|\|)/\n/g' <<<"$cmd")
decide() { jq -n --arg d "$1" --arg r "$2" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'; exit 0; }
secrets='(\.p8|\.p12|\.jks|\.keystore|\.mobileprovision|\.dev\.vars|(^|/)\.env(\.|\b)|Secrets\.xcconfig|google-services\.json|GoogleService-Info\.plist|AuthKey_)'
oracle='quality/(thresholds\.yaml|reference-media)'

grep -Eq 'rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(/|~|\$HOME|\.\.?)(\s|/?$)' <<<"$cmd" && decide deny "Refusing recursive delete of a root/home/project directory."
grep -Eq '(^|\s)sudo\s' <<<"$cmd" && decide deny "sudo is not allowed from the agent. Ask the owner to run it with '! <command>'."
grep -Eq -- '--no-verify|--no-gpg-sign' <<<"$cmd" && decide deny "Don't bypass git hooks; fix the failure instead."
grep -Eq 'git\s+push\s+.*(--force|-f\b|--force-with-lease)' <<<"$cmd" && decide deny "Force push is not allowed."
grep -Eq 'xcrun\s+simctl\s+(erase|delete)\s+all' <<<"$cmd" && decide deny "Don't wipe all simulators; target one device."
grep -Eq "(cat|less|more|head|tail|bat|strings|base64|xxd|cp|scp|curl.*-d\s*@|curl.*-F).*$secrets" <<<"$cmd" && decide deny "That reads or moves a secret file. Secrets must stay out of the agent context — reference them by path in config instead."
grep -Eq "^\s*(sed\s+.*-i|perl\s+-p?i|tee|mv|cp|rm|truncate|yq\s+-i)\b.*$oracle|>>?\s*\S*$oracle" <<<"$segs" && decide deny "quality/thresholds.yaml and reference media are the owner's oracle. Don't modify them; explain to the owner why a threshold should change."
# Commit policy: no direct commits on main (merge commits and conflict resolution during a merge are fine).
if grep -Eq '^\s*git\s+(-C\s+\S+\s+)?commit\b' <<<"$segs"; then
  dir=$(perl -ne 'print "$2\n" if /git\s+-C\s+(["\x27]?)([^"\x27\s]+)\1\s+commit/' <<<"$segs" | head -1)
  [[ -z "$dir" ]] && dir=$(perl -ne 'print "$2\n" if /^\s*cd\s+(["\x27]?)([^"\x27\s]+)\1\s*$/' <<<"$segs" | tail -1)
  [[ -z "$dir" ]] && dir="${hook_cwd:-$PWD}"
  [[ "$dir" != /* && -n "$hook_cwd" ]] && dir="$hook_cwd/$dir"
  branch=$(git -C "$dir" symbolic-ref --short HEAD 2>/dev/null)
  gitdir=$(git -C "$dir" rev-parse --git-dir 2>/dev/null)
  if [[ "$branch" =~ ^(main|master)$ ]] && git -C "$dir" rev-parse -q --verify HEAD >/dev/null && [[ ! -e "$dir/$gitdir/MERGE_HEAD" && ! -e "$gitdir/MERGE_HEAD" ]]; then
    decide deny "Commit policy: don't commit directly on $branch. Create a branch first: git switch -c feat/<slug> (or fix/, chore/, test/, docs/), commit there, then merge with --no-ff."
  fi
fi
grep -Eq 'cloudflared\s+tunnel' <<<"$cmd" && decide ask "A tunnel exposes the local dev server on a public URL."
grep -Eq 'wrangler\s+deploy' <<<"$cmd" && ! grep -Eq -- '--env\s+staging' <<<"$cmd" && decide ask "Deploying the signaling Worker outside staging affects real users."
grep -Eq 'wrangler\s+secret|wrangler\s+(kv|d1|r2)\s+.*(delete|purge)' <<<"$cmd" && decide ask "Changing Cloudflare secrets/data."
grep -Eq '(^|\s)git\s+push(\s|$)' <<<"$cmd" && decide ask "Pushing to the remote."
grep -Eq 'altool|notarytool|fastlane\s+(deliver|pilot|supply)|bundletool.*upload|gcloud\s+firebase\s+test' <<<"$cmd" && decide ask "Uploading to an external store/device farm."
exit 0
