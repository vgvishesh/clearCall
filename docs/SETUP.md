# Owner setup checklist

`make doctor` checks all of this. Items marked 💳 cost money; ⛔ blocks progress.

## Mac toolchain
- ⛔ **macOS 15.6+** (this Mac is 15.5) — required by current Xcode.
- ⛔ **Xcode 26.x** (installed: 13.1, from 2021). App Store uploads have required the iOS 26 SDK since 2026-04-28. Install via the App Store or `xcodes`, then `sudo xcode-select -s /Applications/Xcode.app` and `xcodebuild -runFirstLaunch`. Install an iOS 26 simulator runtime.
- ⛔ **Android SDK**: Android Studio (or `brew install --cask android-commandlinetools`), then `sdkmanager "platform-tools" "emulator" "platforms;android-36" "build-tools;36.0.0" "system-images;android-36;google_apis;arm64-v8a"`. Export `ANDROID_HOME=$HOME/Library/Android/sdk` and add `platform-tools`, `emulator` to PATH.
- **JDK 21** (`brew install --cask temurin@21`). Java 25 is installed but Android Gradle Plugin is happiest on 17/21.
- `brew install xcodegen swiftlint swift-format ktlint ffmpeg uv` and `brew install mobile-dev-inc/tap/maestro` (or `curl -Ls https://get.maestro.mobile.dev | bash`).
- `npm i -g wrangler` (or use `npx wrangler` from `signaling/`).
- Docker Desktop running (quality lab network impairment).

## Accounts
- 💳⛔ **Apple Developer Program** ($99/yr) — required for PushKit VoIP push, CallKit on real devices beyond 7-day dev signing, TestFlight. Create an **APNs auth key (.p8)**; keep it out of the repo.
- 💳 **Google Play Console** ($25 once). **Firebase** project (free) for FCM; download `google-services.json` (gitignored).
- **Cloudflare** account (free): Workers, Durable Objects, Realtime (SFU + TURN, 1,000 GB/mo free). Create an API token scoped to Workers + Realtime; `wrangler login`.
- **GitHub** repo (private) for CI. Note: macOS runner minutes count 10× on private repos.
- Optional: Firebase Test Lab (free daily quota) or BrowserStack for remote device runs.

## Devices
- ⛔ for M3+: at least **1 iPhone + 1 Android phone** (camera, echo cancellation, hardware codecs, CallKit and push cannot be validated on simulators). Ideal: 2 of each plus one low-end Android (that's the real quality bar).
- Wired headphones/earbuds and a speaker to test music mode and echo.

## Secrets (never in git; agents are blocked from reading them)
`signaling/.dev.vars` (local Worker secrets), `android/app/google-services.json`, `ios/Config/Secrets.xcconfig`, `*.p8`, `*.jks`.
