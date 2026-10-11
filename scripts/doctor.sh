#!/usr/bin/env bash
# Toolchain + device readiness. Exit 1 if any blocker is missing.
source "$(dirname "$0")/lib.sh"; set +e
blockers=0
ok()   { printf '  \033[32m✓\033[0m %-22s %s\n' "$1" "$2"; }
warn() { printf '  \033[33m!\033[0m %-22s %s\n' "$1" "$2"; }
bad()  { printf '  \033[31m✗\033[0m %-22s %s\n' "$1" "$2"; blockers=$((blockers+1)); }
verge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; } # $1 >= $2

say "macOS / Xcode"
osv=$(sw_vers -productVersion); verge "$osv" 15.6 && ok macOS "$osv" || bad macOS "$osv (need ≥15.6 for Xcode 26)"
xv=$(xcodebuild -version 2>/dev/null | awk 'NR==1{print $2}')
verge "${xv:-0}" 26.0 && ok Xcode "$xv" || bad Xcode "${xv:-none} (need ≥26 — App Store requires iOS 26 SDK)"
rt=$(xcrun simctl list runtimes 2>/dev/null | grep -Eo 'iOS 2[6-9][.0-9]*' | tail -1)
[[ -n "$rt" ]] && ok "iOS sim runtime" "$rt" || bad "iOS sim runtime" "none ≥ iOS 26"
for t in xcodegen swiftlint swift-format; do have $t && ok $t "$(command -v $t)" || bad $t "brew install $t"; done

say "Android"
[[ -n "${ANDROID_HOME:-}" && -d "$ANDROID_HOME" ]] && ok ANDROID_HOME "$ANDROID_HOME" || bad ANDROID_HOME "Android SDK not found"
have adb && ok adb "$(adb version | head -1)" || bad adb "install platform-tools"
have emulator && ok emulator "" || bad emulator "sdkmanager emulator"
jv=$(/usr/libexec/java_home -V 2>&1 | grep -E '^\s+(17|21)\.' | head -1 | awk '{print $NF}')
[[ -n "$jv" ]] && ok "JDK 17/21" "$jv" || bad "JDK 17/21" "brew install --cask temurin@21"
have ktlint && ok ktlint "" || warn ktlint "brew install ktlint (Gradle plugin also works)"

say "Edge / quality lab"
have node && ok node "$(node -v)" || bad node "install node"
have wrangler || [[ -x signaling/node_modules/.bin/wrangler ]] && ok wrangler "" || warn wrangler "npm i -g wrangler"
have docker && docker info >/dev/null 2>&1 && ok docker "running" || warn docker "not running (needed for netem profiles)"
have ffmpeg && { ffmpeg -hide_banner -filters 2>/dev/null | grep -q libvmaf && ok ffmpeg "with libvmaf" || warn ffmpeg "no libvmaf filter"; } || bad ffmpeg "brew install ffmpeg"
have uv && ok uv "" || warn uv "brew install uv (Python scorers)"
have maestro && ok maestro "" || warn maestro "curl -Ls https://get.maestro.mobile.dev | bash"

say "Devices"
booted=$(xcrun simctl list devices booted 2>/dev/null | grep -c Booted); echo "  iOS simulators booted: $booted"
have xcrun && xcrun devicectl list devices 2>/dev/null | grep -iE "iphone.*(connected|available)" | sed 's/^/  iPhone: /' || true
have adb && adb devices | awk 'NR>1 && NF{print "  android: "$0}' || true

echo; ((blockers==0)) && say "doctor: all blockers clear" || { printf '\033[31mdoctor: %d blocker(s) — see docs/SETUP.md\033[0m\n' $blockers; exit 1; }
