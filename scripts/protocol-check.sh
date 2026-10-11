#!/usr/bin/env bash
# Every fixture must validate against the schema, and every implementation must round-trip every fixture.
source "$(dirname "$0")/lib.sh"
need_scaffold protocol/signaling.schema.json "protocol schema"
say "schema ↔ fixtures"; run_logged protocol-schema npx --yes ajv-cli@5 validate --spec=draft2020 -s "$ROOT/protocol/signaling.schema.json" -d "$ROOT/protocol/fixtures/*.json"
# Each implementation exposes a ProtocolConformance test that reads protocol/fixtures directly.
[[ -e "$ROOT/signaling/package.json" ]] && (cd "$ROOT/signaling" && run_logged protocol-worker pnpm exec vitest run protocol)
[[ -e "$ROOT/ios/project.yml" ]] && ONLY="-only-testing:${IOS_SCHEME}Tests/ProtocolConformanceTests" && (cd "$ROOT/ios" && run_logged protocol-ios xcodebuild test -project "$IOS_SCHEME.xcodeproj" -scheme "$IOS_SCHEME" -destination "platform=iOS Simulator,name=$IOS_SIM" -derivedDataPath build/DerivedData $ONLY)
[[ -e "$ROOT/android/settings.gradle.kts" ]] && (cd "$ROOT/android" && run_logged protocol-android ./gradlew -q :app:testDebugUnitTest --tests '*ProtocolConformanceTest*')
echo "  ✓ protocol conformance"
