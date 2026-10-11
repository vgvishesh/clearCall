#!/usr/bin/env bash
# usage: android.sh build|test|run|lint   (VARIANT=Debug|Qa)
source "$(dirname "$0")/lib.sh"
cmd="${1:-build}"; VARIANT="${VARIANT:-Debug}"
need_scaffold android/settings.gradle.kts "Android app"
cd "$ROOT/android"
JH=$(/usr/libexec/java_home -V 2>&1 | grep -E '^\s+(21|17)\.' | head -1 | awk '{print $NF}'); [[ -n "$JH" ]] && export JAVA_HOME="$JH"
gw() { ./gradlew --console=plain -q "$@"; }
ensure_device() {
  adb get-state >/dev/null 2>&1 && return
  have emulator || fail "no device and no emulator (make doctor)"
  say "starting emulator $ANDROID_AVD"; nohup emulator -avd "$ANDROID_AVD" -no-snapshot-save -no-boot-anim >/dev/null 2>&1 &
  adb wait-for-device; until [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; do sleep 2; done
}
case "$cmd" in
  lint)  run_logged android-lint gw ktlintCheck ;;
  build) run_logged android-build gw ":app:assemble$VARIANT" ;;
  test)  run_logged android-test gw ":app:test${VARIANT}UnitTest" ;;
  run)
    ensure_device; run_logged android-build gw ":app:install$VARIANT"
    adb shell am force-stop "$ANDROID_APP_ID"
    adb shell monkey -p "$ANDROID_APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
    echo "  ✓ launched $ANDROID_APP_ID  (logs: adb logcat --pid=\$(adb shell pidof $ANDROID_APP_ID))" ;;
  *) fail "unknown: $cmd" ;;
esac
