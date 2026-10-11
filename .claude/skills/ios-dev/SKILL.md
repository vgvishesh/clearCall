---
name: ios-dev
description: Build, run, debug and test the iOS app (Swift/SwiftUI, XcodeGen, simulator and physical iPhone, CallKit/PushKit/AVAudioSession). Use for any work under ios/.
---
# iOS development

## Loop
- Project is generated: edit `ios/project.yml`, then `make ios-gen`. Never touch `.xcodeproj`.
- `make ios-build` → `make ios-test` → `make ios-run` (boots `$IOS_SIM`, installs, launches). Full logs: `.claude/state/logs/ios-*.log`.
- QA config: `CONFIG=QA make ios-run` (file-backed capturers, stats exporter, `betterapp://qa/...` deep links).
- Deep link a screen: `xcrun simctl openurl booted "betterapp://contacts"`.
- Logs: `xcrun simctl spawn booted log stream --level debug --predicate 'subsystem == "com.example.clearcall"'`. Use `os.Logger(subsystem:category:)` everywhere, categories: `call`, `media`, `signaling`, `push`, `ui`.
- Push to simulator (non-VoIP only): `xcrun simctl push booted com.example.clearcall payload.apns`. **VoIP pushes, CallKit audio, camera and AEC only work on a real iPhone** → `device-test` skill.
- XcodeBuildMCP tools (if connected) can build/run/screenshot/describe UI; prefer `make` for anything a hook or CI also runs.

## Architecture inside ios/
- `App/` (entry, DI), `Features/<Feature>/` (SwiftUI View + `@Observable` model), `Call/` (CallManager state machine, CallKit provider, audio session), `Media/` (WebRTC wrapper, capture abstraction `MediaSource`, `StatsExporter`), `Signaling/` (WebSocket client, Codable messages generated from/validated against `protocol/`), `Identity/` (Secure Enclave keypair).
- Swift 6 strict concurrency. UI on `@MainActor`; WebRTC callbacks hop explicitly.
- Dependency injection via protocols so tests use fakes for signaling, media and CallKit.

## Pitfalls that kill call quality on iOS
- Configure `AVAudioSession` only in CallKit's `provider(_:didActivate:)`; activate WebRTC audio there (`RTCAudioSession.isAudioEnabled`), deactivate in `didDeactivate`. Use `useManualAudio = true`.
- Voice mode: `.playAndRecord` + `.voiceChat` (enables Apple's voice processing). Music mode: `.playAndRecord` + `.default` + voice processing bypass, and stereo/fullband Opus.
- Every PushKit VoIP push must `reportNewIncomingCall` immediately or iOS stops delivering pushes.
- Handle route changes (Bluetooth/AirPods, speaker) and interruptions (GSM call) explicitly; test them on device.
