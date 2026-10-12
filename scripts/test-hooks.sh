#!/usr/bin/env bash
# Regression tests for .claude/hooks. Run after editing any hook: scripts/test-hooks.sh
cd "$(dirname "$0")/.." || exit 1
H=.claude/hooks; P=$PWD; fails=0
dec() { jq -rc '.hookSpecificOutput.permissionDecision // .decision // "allow"' 2>/dev/null || echo allow; }
expect() { # name expected hook json
  local got; got=$(echo "$4" | "$H/$3" | dec); [[ -z "$got" ]] && got=allow
  if [[ "$got" == "$2" ]]; then printf '  ✓ %-42s %s\n' "$1" "$got"; else printf '  ✗ %-42s got %s, want %s\n' "$1" "$got" "$2"; fails=$((fails+1)); fi
}
b() { jq -n --arg c "$1" '{tool_input:{command:$c}}'; }
f() { jq -n --arg p "$P/$1" --arg c "$2" '{tool_input:{file_path:$p,content:$c}}'; }

echo "guard_bash"
expect "rm -rf ~"                   deny  guard_bash.sh "$(b 'rm -rf ~')"
expect "cat a .p8 key"              deny  guard_bash.sh "$(b 'cat ios/AuthKey_ABC.p8')"
expect "sed -i thresholds"          deny  guard_bash.sh "$(b "sed -i '' s/80/60/ quality/thresholds.yaml")"
expect "git commit skipping hooks"  deny  guard_bash.sh "$(b 'git commit --no-verify -m x')"
expect "force push"                 deny  guard_bash.sh "$(b 'git push --force origin main')"
expect "sudo"                       deny  guard_bash.sh "$(b 'sudo xcode-select -s /Applications/Xcode.app')"
expect "wrangler deploy (prod)"     ask   guard_bash.sh "$(b 'pnpm exec wrangler deploy')"
expect "wrangler deploy staging"    allow guard_bash.sh "$(b 'pnpm exec wrangler deploy --env staging')"
expect "git push"                   ask   guard_bash.sh "$(b 'git push origin feat/x')"
expect "docker prune asks"          ask   guard_bash.sh "$(b 'docker builder prune -af')"
MIN_FREE_GB=100000 expect "docker build w/o disk headroom" deny guard_bash.sh "$(b 'docker build -t x quality/netem')"
expect "docker build with headroom"  allow guard_bash.sh "$(b 'docker build -t x quality/netem')"
MIN_RUN_FREE_GB=100000 expect "docker run w/o run headroom" deny guard_bash.sh "$(b 'docker run --rm alpine:3 true')"
MIN_FREE_GB=100000 expect "docker run uses run threshold" allow guard_bash.sh "$(b 'docker run --rm alpine:3 true')"
MIN_FREE_GB=100000 expect "compose up --build uses build threshold" deny guard_bash.sh "$(b 'docker compose up --build')"
expect "make ios-build"             allow guard_bash.sh "$(b 'make ios-build')"
expect "read thresholds"            allow guard_bash.sh "$(b 'cat quality/thresholds.yaml')"
expect "redirect into thresholds"   deny  guard_bash.sh "$(b 'echo x > quality/thresholds.yaml')"
expect "chained rm of ref media"    deny  guard_bash.sh "$(b 'make doctor && rm -r quality/reference-media')"
expect "heredoc that mentions it"   allow guard_bash.sh "$(b $'cat > doc.md <<\'EOF\'\nnever edit quality/thresholds.yaml; git commit --no-verify is banned\nEOF\necho done')"
expect "danger after a heredoc"     deny  guard_bash.sh "$(b $'cat > a.md <<EOF\nhi\nEOF\nsudo rm x')"

echo "guard_paths"
expect "write thresholds.yaml"      deny  guard_paths.sh "$(f quality/thresholds.yaml x)"
expect "write reference media"      deny  guard_paths.sh "$(f quality/reference-media/a.wav x)"
expect "edit pbxproj"               deny  guard_paths.sh "$(f ios/BetterApp.xcodeproj/project.pbxproj x)"
expect "write .dev.vars"            deny  guard_paths.sh "$(f signaling/.dev.vars x)"
expect "add XCTSkip"                ask   guard_paths.sh "$(f ios/T.swift 'throw XCTSkip("flaky")')"
expect "add @Ignore"                ask   guard_paths.sh "$(f android/T.kt '@Ignore fun t(){}')"
expect "normal kotlin"              allow guard_paths.sh "$(f android/A.kt 'fun a() = 1')"

echo "commit policy"
repo=$(mktemp -d); git -C "$repo" init -q -b main; git -C "$repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
cj() { jq -n --arg c "$1" --arg d "$repo" '{cwd:$d,tool_input:{command:$c}}'; }
expect "commit on main"             deny  guard_bash.sh "$(cj 'git commit -m x')"
expect "commit on main via -C"      deny  guard_bash.sh "$(jq -n --arg c "git -C $repo commit -m x" '{cwd:"/",tool_input:{command:$c}}')"
expect "add && commit on main"      deny  guard_bash.sh "$(cj 'git add -A && git commit -m x')"
git -C "$repo" switch -q -c feat/x
expect "commit on feature branch"   allow guard_bash.sh "$(cj 'git commit -m x')"
git -C "$repo" switch -q feat/x; echo y > "$repo/g"; git -C "$repo" add g; git -C "$repo" -c user.name=t -c user.email=t@t commit -q -m feat
git -C "$repo" switch -q main; git -C "$repo" merge -q --squash feat/x >/dev/null
expect "commit completing squash merge" allow guard_bash.sh "$(cj 'git commit -m "feat: x"')"
rm -rf "$repo"

echo "post_edit / stop_verify"
sid="selftest-$$"; mkdir -p protocol; tmp=protocol/.selftest.json; echo '{}' > "$tmp"
ctx=$(jq -n --arg p "$P/$tmp" --arg s "$sid" '{session_id:$s,tool_input:{file_path:$p}}' | "$H/post_edit.sh" | jq -r '.hookSpecificOutput.additionalContext // ""')
[[ "$ctx" == *protocol-change* ]] && echo "  ✓ protocol edit injects protocol-change reminder" || { echo "  ✗ protocol reminder missing"; fails=$((fails+1)); }
grep -qx "$P|$tmp" ".claude/state/changed-$sid.txt" && echo "  ✓ change recorded for Stop gate" || { echo "  ✗ change not recorded"; fails=$((fails+1)); }
jq -n --arg s "$sid" '{session_id:$s}' | "$H/stop_verify.sh" >/dev/null; [[ ! -e ".claude/state/changed-$sid.txt" ]] && echo "  ✓ stop gate passes + clears when verify green" || { echo "  ✗ stop gate"; fails=$((fails+1)); }
rm -f "$tmp" ".claude/state/changed-$sid.txt" ".claude/state/stopblocks-$sid"

((fails==0)) && echo "hooks: all green" || { echo "hooks: $fails failure(s)"; exit 1; }
