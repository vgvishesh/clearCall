# Architecture — Clearcall V1 (web)

Status: **Decided** = build on it · **Proposed** = default unless owner objects · **Measure** = the quality lab decides.

## 1. Shape (ADR-0003)
```
 Browser A ─────── WebSocket (encrypted signaling) ──────┐
    │                                                     ▼
    │                                   Cloudflare Worker (free tier)
    │                                     ├─ static assets: web/dist (PWA)
    │                                     ├─ Room Durable Object per call (WebSocket hibernation)
    │                                     └─ TURN credential minting (if configured)
    │                                                     ▲
 Browser B ─────── WebSocket (encrypted signaling) ──────┘
    ║
    ╚═══ audio/video: direct P2P, DTLS-SRTP (STUN; TURN relay only when direct fails)
```
One deployable: the Worker serves the app and signaling from the same origin (no CORS, one URL to share).

## 2. Call links and keys (ADR-0004) — Decided
- Link: `https://<host>/c#<secret>`, where `secret` = 32 random bytes, base64url (43 chars). The fragment is never sent to any server.
- `roomId = base64url(HKDF(secret, "clearcall/room-id"))[0..22]` — what the server sees.
- `sigKey = HKDF(secret, "clearcall/signal-key")` → AES-GCM-256. Every signaling payload between two peers is encrypted with a random 96-bit IV and AAD = `roomId|from|to|v1`. The server relays opaque blobs; it can't read SDP, names or state, and can't inject or MITM (swapping DTLS fingerprints would require the key).
- Anyone with the link can join (that's the product). Room capacity: 10.

## 3. Signaling (protocol/) — Decided
- Server-visible: `peerId` (random 16 chars per tab-session), join/leave, opaque `signal` blobs. `welcome` carries the current peer list and `iceServers`, so TURN credentials are only handed to room participants.
- Peer⇄peer (encrypted): `hello` (name), `sdp`, `ice`. After connect, an `RTCDataChannel` ("ctl") carries in-call state (`state`: name, mic, cam, mode; `view`: rendered tile size; `bye`).
- **Perfect negotiation** (W3C pattern) per pair; polite peer = lexicographically smaller `peerId`. The newcomer initiates; glare/renegotiation is safe either way.
- **Resilience:** WebSocket reconnect with backoff + `resume` (same `peerId`), Room keeps a disconnected peer for 20 s before `peer-left`. Media keeps flowing P2P while signaling is down. ICE restart on `connectionState=failed`/prolonged `disconnected` (network switch Wi-Fi⇄cellular).
- Limits in the DO: 10 peers, 64 KiB/message, per-socket message rate limit. Heartbeat via hibernation auto-response (`ping`→`pong`), so idle rooms cost nothing.

## 4. Media — Proposed, then Measure
- **Audio:** Opus, `useinbandfec=1; usedtx=1; maxaveragebitrate=128000` advertised; sender bitrate set with `RTCRtpSender.setParameters`: Voice 32 kbps, Music 96 kbps. RED (`red/48000/2`) preferred via `setCodecPreferences` where supported — **Measure** (keeps if it wins in lossy profiles at acceptable cost in big meshes).
- **Voice mode** (default): `echoCancellation, noiseSuppression, autoGainControl = true`. ML noise suppression (RNNoise/DeepFilterNet WASM in an AudioWorklet) is a V1.1 track, shipped only if DNSMOS improves without hurting speech (SIG).
- **Music mode:** re-acquire mic with NS/AGC off (EC stays on), 96 kbps, mono. Switch = `replaceTrack`, no renegotiation.
- **Video codec:** choose per device using `navigator.mediaCapabilities.encodingInfo({type:"webrtc"})`, preferring `powerEfficient` VP9 → H.264 → VP8 via `setCodecPreferences` — **Measure**.
- **Mesh bandwidth policy** (`web/src/core/policy.ts`, ADR-0005), per outgoing connection:

| Participants | Max encode | Max bitrate per peer | fps |
|---|---|---|---|
| 2 | 720p | 1500 kbps | 30 |
| 3–4 | 360p | 600 kbps | 30 |
| 5–10 | 180p | 150 kbps | 15 |
  Further capped by the receiver's `view` message (don't send 720p to a 120 px tile) and by `degradationPreference="balanced"`. Hidden tab ⇒ ask peers to pause our video.
- **Active speaker:** from `audioLevel` in inbound-rtp stats (no extra AudioContext per peer).

## 5. Web app
- Preact + `@preact/signals` + Vite + TS strict. No CSS framework: design tokens in `web/src/ui/tokens.css`.
- `core/` exposes a `CallController` (`web/src/core/types.ts`); `ui/` only talks to that interface. A `FakeCallController` lets UI be built and screenshot-tested without WebRTC.
- Screens: Home → Lobby (preview, mic meter, name, Join) → Call (adaptive grid, controls: mic, cam, flip, share, more[music mode], leave) → Ended. Error states: permissions denied (per-platform help), room full, unsupported browser, can't connect.
- PWA: manifest + service worker (app shell cached; never caches `/api/*`). iOS "Add to Home Screen" hint after the first call.
- Phone niceties: Screen Wake Lock during calls, `playsinline` video, handle `visibilitychange` (iOS stops camera in background → restore on return), `devicechange`, track `ended`.
- QA hook: with `?qa=1`, `window.__clearcall` exposes state and a stats summary for E2E assertions.

## 6. Testing
- Unit: Vitest (web core logic: crypto, links, policy, SDP munging, negotiation state; worker via `@cloudflare/vitest-pool-workers`).
- E2E: Playwright against `wrangler dev` with real built assets. Chromium fake media (`--use-fake-device-for-media-stream`, or files via `--use-file-for-fake-*-capture`); WebKit and Firefox where fake capture works. Scenarios: 2/3/4/10 participants, mute/cam toggles, leave/rejoin, signaling drop + resume, ICE restart, room full.
- Quality lab: Chromium peers with reference media → received media recorded → VMAF (video), PESQ/DNSMOS (audio), getStats (bitrate, freezes, concealment, RTT) → `thresholds.yaml` gates. Network impairment via `tc netem` in Docker (Linux) — the only reliable way to shape WebRTC UDP.
- Real devices: owner tests on phones via a shareable URL (a Cloudflare quick tunnel or staging deploy).

## 7. Deferred
Native apps (ADR-0001/0002, `docs/paused-native/`), contacts + ringing via Web Push, SFU for 10-person HD video, screen share, ML noise suppression (V1.1 track).
