#!/usr/bin/env bash
# PreToolUse(Edit|Write|MultiEdit|NotebookEdit): protect secrets, generated files, the quality oracle; flag test-skipping.
in=$(cat)
path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' <<<"$in")
content=$(jq -r '[.tool_input.content, .tool_input.new_string, (.tool_input.edits // [] | map(.new_string) | join("\n"))] | map(select(.!=null)) | join("\n")' <<<"$in")
decide() { jq -n --arg d "$1" --arg r "$2" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'; exit 0; }
case "$path" in
  *.p8|*.p12|*.jks|*.keystore|*.mobileprovision|*/.dev.vars|*/.env|*/.env.*|*Secrets.xcconfig|*google-services.json|*GoogleService-Info.plist)
    decide deny "Secret file. The owner manages it; reference it from config instead." ;;
  *.xcodeproj/*|*.pbxproj|*/DerivedData/*|*/build/*|*/.gradle/*)
    decide deny "Generated file. For iOS edit ios/project.yml and run 'make ios-gen'; never hand-edit build output." ;;
  */quality/thresholds.yaml|*/quality/reference-media/*)
    decide deny "This is the quality oracle; only the owner changes it. If you believe a threshold is wrong, stop and explain why with data." ;;
esac
if grep -Eq 'XCTSkip|@Ignore\b|@Disabled\b|\b(it|test|describe)\.skip\(|\bxit\(|\.only\(|@Suppress\("UNUSED' <<<"$content"; then
  decide ask "This edit skips/narrows tests. Allowed only with an owner-approved reason."
fi
exit 0
