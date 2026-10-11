#!/usr/bin/env bash
# usage: screenshot.sh ios|android|both <name>   → quality/reports/screens/<name>-<platform>.png
source "$(dirname "$0")/lib.sh"
which="${1:-both}"; name="${2:-screen}"; out="$ROOT/quality/reports/screens"; mkdir -p "$out"
if [[ $which == ios || $which == both ]]; then
  xcrun simctl io booted screenshot "$out/$name-ios.png" >/dev/null 2>&1 && echo "$out/$name-ios.png" || echo "  (no booted iOS simulator)"
fi
if [[ $which == android || $which == both ]]; then
  adb get-state >/dev/null 2>&1 && adb exec-out screencap -p > "$out/$name-android.png" && echo "$out/$name-android.png" || echo "  (no Android device)"
fi
