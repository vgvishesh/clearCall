---
name: webrtc-media
description: Domain reference for libwebrtc media tuning on iOS/Android — Opus settings, video codecs, simulcast/SVC, bandwidth estimation, SDP, getStats fields, audio processing and E2EE. Use when writing or reviewing any code in Media/ or media/.
---
# WebRTC media reference
Always verify a tuning claim in the quality lab; these are starting points, not truths.

## Audio (Opus)
- Voice mode fmtp: `useinbandfec=1; usedtx=1; maxaveragebitrate=32000; stereo=0`. Enable RED (`red/48000/2`, negotiated before opus) for lossy links — costs ~2× audio bitrate, worth it under 3–10% loss.
- Music mode: `maxaveragebitrate=96000–128000; stereo=1; sprop-stereo=1; usedtx=0`; disable NS, AGC, high-pass filter; keep AEC unless headphones are routed (check route). `ptime=20`.
- Noise suppression candidates: WebRTC NS (baseline), RNNoise (~small CPU), DeepFilterNet (best quality, check battery). Implement as an audio processing module hook so it's swappable and A/B-able in the lab.
- Opus 1.5 DRED / deep PLC may not be in the prebuilt SDK — needs a custom libwebrtc build; only pursue if the lab shows loss-recovery is the bottleneck.

## Video
- Codec preference set by capability probe at startup, persisted per device model. Candidates: AV1 (SW encode ≤360p is viable, best at low rates), VP9 (SVC L3T3 for SFU), H.264 HW (best battery; use High profile where supported).
- 1:1: single layer, `degradationPreference = balanced` (maintain-framerate for motion, maintain-resolution for screen share).
- SFU: simulcast 3 layers (scaleResolutionDownBy 4/2/1) or SVC; receiver requests the layer matching rendered tile size; pause video for off-screen tiles.
- Cap starting bitrate sensibly (`x-google-start-bitrate`), let GCC ramp. Never set min bitrate high — it kills calls on weak links.

## Bandwidth budget levers (req. 6)
Audio DTX, receiver-side layer selection, top-N audio forwarding in groups, pause hidden video, lower fps before lower resolution for talking heads, codec choice.

## getStats fields the lab and apps export
outbound-rtp: `bytesSent, framesEncoded, qualityLimitationReason, qualityLimitationDurations, encoderImplementation, targetBitrate`
inbound-rtp: `jitter, packetsLost, framesDropped, freezeCount, totalFreezesDuration, concealedSamples, concealmentEvents, jitterBufferDelay/jitterBufferEmittedCount, pliCount, nackCount`
candidate-pair (selected): `currentRoundTripTime, availableOutgoingBitrate`; local candidate type (`relay` = TURN in use).

## E2EE (SFU path)
`RTCFrameEncryptor`/`FrameEncryptorInterface` per sender, decryptor per receiver; AES-GCM with per-sender keys, key epoch rotated on membership change; keys distributed via signaling encrypted to each participant's identity key. Leave codec headers unencrypted where the SFU needs them for layer switching.
