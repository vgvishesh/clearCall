---
name: ui-verify
description: Visually verify UI on iOS and Android by launching, navigating via deep link, taking screenshots, and inspecting them for parity and polish. Use before declaring any UI work done, and when asked how a screen looks.
---
# ui-verify
1. `make ios-run` and `make android-run` (QA build if the screen needs a fake call: `CONFIG=QA` / `VARIANT=Qa`).
2. Navigate with deep links (see ios-dev / android-dev). Wait ~2s for animations.
3. `make screenshots NAME=<screen>` → `quality/reports/screens/<screen>-{ios,android}.png`.
4. **Read both PNG files** and check:
   - Same information, same order, same primary action on both platforms (platform-idiomatic chrome is fine).
   - Tap targets ≥ 44pt / 48dp, nothing truncated or clipped, safe areas respected.
   - Dark mode: `xcrun simctl ui booted appearance dark`, `adb shell cmd uimode night yes`; screenshot again.
   - Large text: `xcrun simctl ui booted content_size extra-extra-large`, `adb shell settings put system font_scale 1.5`.
   - Simplicity bar: a first-time user can call someone from the home screen in ≤2 taps.
5. Reset appearance/font scale. Report findings with the screenshot paths. Fix and repeat until clean.
Interactive exploration: mobile-mcp / XcodeBuildMCP can tap and read the accessibility tree; turn any flow you exercise by hand into a Maestro flow in `quality/e2e/`.
