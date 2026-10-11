---
name: device-test
description: Install and test on physical iPhones and Android phones, including real network conditions, VoIP push, CallKit/Telecom, Bluetooth, echo and camera. Use when a behavior can't be validated on simulators/emulators.
---
# device-test
- iPhone: `xcrun devicectl list devices`; build for device with `xcodebuild ... -destination 'platform=iOS,id=<UDID>' -allowProvisioningUpdates`; install `xcrun devicectl device install app --device <UDID> <path.app>`; launch `xcrun devicectl device process launch --device <UDID> com.example.clearcall`. Signing needs the owner's Apple Developer team (`DEVELOPMENT_TEAM` in `ios/Config/Signing.xcconfig`, gitignored).
- Android: `adb devices`; `adb -s <serial> install -r app-qa.apk`. Screens: `adb -s <serial> exec-out screencap -p`.
- Network conditions on devices: iOS Settings → Developer → Network Link Conditioner (owner toggles); Android/all: route the phone's Wi-Fi through the lab's netem gateway (`quality/netem-gateway/README.md`).
- Things that ONLY a device proves (put them in the plan's acceptance criteria): VoIP push wakes a killed app; CallKit/Telecom lock-screen answer; echo with speakerphone at max volume; AirPods/Bluetooth route switch mid-call; GSM call interruption; 30-min call thermal/battery; hardware codec selection.
- You can't physically handle devices — when a step needs a human (answer a call, plug headphones), write a short numbered checklist for the owner and ask them to report results.
