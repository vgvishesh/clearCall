---
name: android-dev
description: Build, run, debug and test the Android app (Kotlin/Compose, Gradle, emulator and physical devices, Telecom/ConnectionService, FCM, foreground services). Use for any work under android/.
---
# Android development

## Loop
- `make android-build` → `make android-test` → `make android-run` (starts AVD `$ANDROID_AVD` if no device). QA variant: `VARIANT=Qa make android-run`.
- Deep link: `adb shell am start -a android.intent.action.VIEW -d "betterapp://contacts"`.
- Logs: `adb logcat --pid=$(adb shell pidof com.example.clearcall) -v color`; tag conventions `BA/call`, `BA/media`, `BA/signaling`, `BA/push`.
- Emulator network shaping: `adb emu network delay gprs|edge|umts|none`, `adb emu network speed lte|full`. Emulator camera can be fed a virtual scene; real AEC/codecs need a device → `device-test`.
- Dependencies only via `gradle/libs.versions.toml`.

## Architecture inside android/
- Single `app` module to start; packages mirror iOS: `app`, `feature.<x>` (Composable + ViewModel w/ StateFlow), `call` (CallManager state machine, Core-Telecom `CallsManager` integration, foreground service), `media` (WebRTC wrapper, `MediaSource` capture abstraction, `StatsExporter`), `signaling` (OkHttp WebSocket, kotlinx.serialization messages matching `protocol/`), `identity` (Keystore keypair).
- Coroutines with structured concurrency; no `GlobalScope`. Hilt (or manual DI) so tests use fakes.

## Pitfalls that kill call quality on Android
- `AudioManager.MODE_IN_COMMUNICATION` during calls, restore after. Prefer `JavaAudioDeviceModule` with hardware AEC/NS **only where it's not broken** — keep a device allowlist; fall back to WebRTC software AEC3/NS.
- Foreground service type `phoneCall` (+ `camera`/`microphone`) must be started before capture on Android 14+.
- FCM: high-priority data message → full-screen intent notification → Telecom incoming call. Test with the app killed and in Doze (`adb shell dumpsys deviceidle force-idle`).
- Bluetooth SCO/LE audio routing via Telecom `CallEndpoint`, not manual `startBluetoothSco`.
- Test on a low-end device; hardware H.264 encoders vary wildly.
