#!/usr/bin/env bash
# usage: ios.sh gen|build|test|run|lint [--config qa]
source "$(dirname "$0")/lib.sh"
cmd="${1:-build}"; CONFIG="${CONFIG:-Debug}"
need_scaffold ios/project.yml "iOS app"
cd "$ROOT/ios"
DD="$ROOT/ios/build/DerivedData"
DEST="platform=iOS Simulator,name=$IOS_SIM"
gen()   { have xcodegen || fail "xcodegen missing (make doctor)"; run_logged ios-gen xcodegen generate --quiet; }
xb()    { xcodebuild -project "$IOS_SCHEME.xcodeproj" -scheme "$IOS_SCHEME" -configuration "$CONFIG" \
            -destination "$DEST" -derivedDataPath "$DD" -skipPackagePluginValidation "$@"; }
boot()  { xcrun simctl boot "$IOS_SIM" 2>/dev/null || true; xcrun simctl bootstatus "$IOS_SIM" -b >/dev/null; }
case "$cmd" in
  gen)   gen ;;
  lint)  have swiftlint && run_logged ios-lint swiftlint lint --quiet --strict || echo "  (swiftlint missing — skipped)" ;;
  build) gen; run_logged ios-build xb build ;;
  test)  gen; run_logged ios-test xb test -resultBundlePath "$ROOT/.claude/state/logs/ios-test-$(date +%s).xcresult" ;;
  run)
    gen; boot; run_logged ios-build xb build
    app=$(find "$DD/Build/Products/$CONFIG-iphonesimulator" -maxdepth 1 -name '*.app' | head -1)
    [[ -n "$app" ]] || fail "built .app not found"
    xcrun simctl install "$IOS_SIM" "$app"
    xcrun simctl terminate "$IOS_SIM" "$IOS_BUNDLE_ID" 2>/dev/null || true
    xcrun simctl launch "$IOS_SIM" "$IOS_BUNDLE_ID" ${LAUNCH_ARGS:-} >/dev/null
    open -a Simulator; echo "  ✓ launched $IOS_BUNDLE_ID on $IOS_SIM  (logs: xcrun simctl spawn booted log stream --predicate 'subsystem == \"$IOS_BUNDLE_ID\"')" ;;
  *) fail "unknown: $cmd" ;;
esac
