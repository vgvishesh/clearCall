---
name: webrtc-media
description: Browser WebRTC reference for Clearcall's engine — perfect negotiation, ICE restart, data channels, Opus/RED/DTX settings, codec preferences, RTCRtpSender.setParameters bitrate control, mesh bandwidth policy, getStats fields, and cross-browser (Safari/Chrome/Firefox) differences. Use when writing or reviewing web/src/core.
---
# WebRTC in the browser — Clearcall reference
Verify tuning claims in the quality lab; these are starting points.

## Negotiation
- W3C **perfect negotiation**: `makingOffer`, `ignoreOffer`, `isSettingRemoteAnswerPending`; polite = smaller peerId. Use `setLocalDescription()` with no args. Rollback is implicit in modern browsers.
- Add transceivers explicitly (`addTransceiver(track, {direction:"sendrecv", streams:[stream]})`) so codec preferences and `sendEncodings` can be set at creation.
- `negotiationneeded` → offer. Queue remote ICE candidates until `remoteDescription` is set.
- ICE restart: on `connectionState === "failed"` call `pc.restartIce()` (the polite/impolite logic still holds); on `disconnected` wait ~4 s then restart. Back off; give up after 3 tries → mark peer `failed` in UI with "Reconnect" action.
- Data channel `ctl`: `negotiated: true, id: 0` on both sides (no extra negotiation), ordered.

## Audio
- Capture (voice): `{echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1}`. Music: NS/AGC false, EC true. Switch by acquiring a new track + `sender.replaceTrack()`.
- Opus fmtp munge on local SDP (both offer/answer): `useinbandfec=1;usedtx=1;maxaveragebitrate=128000` (append/replace in the `a=fmtp:<opus pt>` line). Bitrate per mode via `setParameters({encodings:[{maxBitrate}]})`.
- RED: if `RTCRtpReceiver.getCapabilities('audio').codecs` includes `audio/red`, `setCodecPreferences([red, opus, ...rest])`. Measure in lab.

## Video
- Codec choice: `navigator.mediaCapabilities.encodingInfo({type:'webrtc', video:{contentType:'video/VP9', width, height, bitrate, framerate}})` → prefer powerEfficient VP9 → H264 → VP8; reorder `setCodecPreferences`. Safari: H264 HW is the safe default.
- Per-connection encode caps via `sender.setParameters`: `maxBitrate`, `scaleResolutionDownBy`, `maxFramerate`; always read-modify-write `getParameters()`. `degradationPreference` where supported.
- Policy table lives in `web/src/core/policy.ts` (ADR-0005), inputs: participant count, receiver's `view` (tile height px × devicePixelRatio), our tab visibility.

## Stats (getStats) used by UI + tests
- `inbound-rtp` (kind audio/video): `bytesReceived, packetsLost, jitter, framesDecoded, framesDropped, freezeCount, totalFreezesDuration, concealedSamples, totalSamplesReceived, audioLevel, jitterBufferDelay, jitterBufferEmittedCount`.
- `outbound-rtp`: `bytesSent, qualityLimitationReason, frameHeight, framesPerSecond, targetBitrate`.
- `candidate-pair` (selected via `transport.selectedCandidatePairId`): `currentRoundTripTime, availableOutgoingBitrate`; local candidate `candidateType` (`relay` = TURN).
- Connection quality badge: good if RTT<200ms & loss<2%; fair if RTT<400 & loss<6%; else poor.

## Cross-browser notes
- Safari: no `RTCRtpSender.setStreams` gaps, but `setCodecPreferences` exists since 16; `audioLevel` present; `getStats` field coverage smaller (no `freezeCount` on older versions) — treat missing fields as undefined, never crash.
- Firefox: `setParameters` requires encodings length unchanged. Firefox (157+) answers `mediaCapabilities.encodingInfo({type:"webrtc"})` and claims H264 power-efficient, but its H264 sender can go silent for good on a mid-stream `scaleResolutionDownBy` change — the engine ignores that claim (`codecs.untrustedPowerEfficient`), so Gecko keeps the tier order (H264 last). Don't re-trust it without a Firefox 3-party `--repeat-each=10` run.
