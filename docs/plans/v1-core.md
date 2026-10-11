# Plan: V1 core — link calls for 2–10 people (milestones W1–W2)

Feature branch: `feat/v1-core`. Package branches (one worktree agent each) are cut from it and merged back with `--no-ff`; the feature branch is squash-merged to `main` after validation.

## Goal
Serves V1 requirements 1–7 (CLAUDE.md): tap **Start a call** → share link → others tap link → everyone sees and hears each other, P2P, up to 10, robust to network blips, with a calm dark UI on phones.


## Plan-review decisions (override anything below that conflicts)
**Coordination**
- Contract files are frozen during the parallel run: `protocol/**` (incl. `FLOWS.md`, `src/dev.ts`), `web/src/core/types.ts`, `web/src/core/testids.ts`, `Makefile`, `scripts/lib.sh|verify.sh|dev.sh|e2e.sh|bundle-size.sh`, `e2e/playwright.config.ts`, all `package.json`s and `pnpm-lock.yaml`, `docs/PLAN.md`. Propose changes in your final report instead.
- **No new dependencies.** Everything planned is pre-installed (web: preact, signals, vite, vite-plugin-pwa, @vite-pwa/assets-generator, vitest, happy-dom, @testing-library/preact; signaling: wrangler, vitest 4 + pool-workers; e2e: @playwright/test, @axe-core/playwright; quality: @playwright/test, tsx, yaml, vitest). Python scorers use `uv run` with inline script metadata (no repo lockfile impact).
- `web/src/core/controller.ts` exists as a stub exporting `createCallController`; B replaces it, C imports it statically.
- C owns `scripts/` nothing; D owns `scripts/diag.sh` (target already in Makefile: `make diag N= DURATION= ARGS=`). `make bundle-size` exists and runs inside `verify web`.
- C's screens suite must not edit `e2e/playwright.config.ts`; create per-device contexts in the spec via `browser.newContext({...devices["iPhone 15"]})` etc.
- Only the orchestrator edits `docs/PLAN.md`.

**Connection semantics** — `protocol/FLOWS.md` is now normative: newcomer offers / answerer reuses transceivers (exactly 3 m-lines per pair), hello resets a pair, resume diff rules, reload = new participant (peerId in memory only; `leave` on pagehide), impolite side drives ICE restart and calls `setConfiguration` with fresh iceServers first, per-peer serialized signal queue, `error{unknown-peer, peerId}`.

**Audio ownership** — the controller plays remote audio via hidden per-participant `<audio>` elements and owns `audioBlocked`; the UI always renders `<video muted playsinline autoplay>`.

**Lobby/devices** — lobby device problems stay in phase `lobby` with `error` set; `local.camAvailable` / `local.micAvailable` say which device; `endedAt` exists; controller is reusable after ended/error (see types.ts docs). `createCallController()` installs telemetry and the QA hook itself.

**Signaling details (A)** — capacity counts away peers; `welcome.peers` in join order; on resume, ignore close events from a socket that is no longer the one bound to that peerId; dead-socket detection via `getWebSocketAutoResponseTimestamp` in `alarm()`; rate limit burst 400 / 50 msg/s with a test where a 10th peer joins a 9-peer room under the limit; TURN credentials minted only after a successful join, cached per room ~10 min, ≤ 1 mint per IP per minute; TTL 12 h.

**Media details (B)** — mode-dependent Opus fmtp: voice `useinbandfec=1;usedtx=1`, music `useinbandfec=1;usedtx=0` (mode change renegotiates via perfect negotiation); actual bitrates via `setParameters` (32 kbps voice / 96 kbps music). RED **off by default** behind a flag the lab can flip (decided by `3g_lossy` data). Music mode keeps echo cancellation ON (UI shows a "use headphones for best music" hint). iOS: stop the old track before re-acquiring (switchCamera/setMode), then `replaceTrack`. Use `navigator.audioSession.type = "play-and-record"` where available. Strip participant names from anything sent to `/api/dev/log`.

**UI details (C)** — FakeCallController + canvas fakes load via dynamic import only when `?fake=1` (not in the entry chunk). Name input `maxlength=40`. PWA `registerType: "autoUpdate"`, external `registerSW.js` (no inline script), version-mismatch Reload calls `updateSW(true)`. CSP `connect-src 'self'` (verify WebSocket works in Chromium/WebKit/Firefox E2E; if a browser needs it, add the explicit same-host `wss:` at runtime via a `<meta>`-free approach and report) plus `frame-ancestors 'none'`.

**Tests (D)** — permission-denied tests use a separate browser launched **without** `--use-fake-ui-for-media-stream` and without granted permissions; 10/11-party specs `test.describe.configure({mode:"serial"})` with per-test timeouts ≥ 180 s; reload spec = "rejoins as a new participant; old tile gone ≤ 20 s". `diag` flags as a hard anomaly a run where `worker.log` has zero `[client ` or `[stats ` lines.

**Machine-checkable acceptance (replaces vague items)**
- C: `screens.spec.ts` asserts for every scenario × device: PNG written, no horizontal overflow (`scrollWidth <= innerWidth`), the scenario's required testids visible, `@axe-core/playwright` color-contrast violations = 0. A vitest asserts manifest fields; an E2E asserts `navigator.serviceWorker.controller` after reload. `make bundle-size` ≤ 100 KB. (Visual review of PNGs is still required and recorded in the report, not a gate.)
- A: the two-socket relay test in vitest is the smoke.
- Media (criterion 4) from `make quality` with `thresholds.proposed.yaml` until the owner adopts thresholds; a proposed-threshold breach fails the criterion. Profiles and expectations: `good_wifi` 2-party mean video send ≤ 1.5 Mbps; `group_10` at 4 peers ≤ 600 kbps per connection and at 10 peers ≤ 150 kbps per connection @ ≤ 15 fps; audio ≤ 32 kbps voice, ≤ 96 kbps `music_mode`; a silent participant's audio send < 5 kbps (DTX).

**Owner pings to schedule (W5 real devices)** — iOS autoplay + "Tap to enable audio", background/lock-screen camera & audio, wake lock in standalone PWA, speaker vs earpiece routing, Android Chrome install + call, music-mode echo on loudspeaker.

## Contracts (already on main — do not change without telling the orchestrator)
- `protocol/src/messages.ts`, `protocol/src/crypto.ts`, `protocol/FLOWS.md`
- `web/src/core/types.ts` (CallController, CallState, QaHook) and `web/src/core/testids.ts`
If a package finds the contract insufficient: implement the closest thing that fits, and list the proposed contract change in its final report. Do not edit contract files.

## Work packages (run in parallel; paths are disjoint)

### A — Signaling Worker · agent `signaling-engineer` · branch `pkg/signaling` · DEV_PORT 8788
Paths: `signaling/**` only.
1. `Room` DO per the `signaling-worker` skill: hibernation API, attachments `{peerId, joinedAt, awayUntil?}`, auto-response ping/pong.
2. Messages: validate with `parseClientMessage`; first message must be `join` (else `error{not-joined}`); `v !== PROTOCOL_VERSION` → `error{version}` + close. Fresh join: if 10 active peers → `error{room-full}` + close (4001); if peerId already present and not resuming → `error{duplicate-peer}` + close. `welcome{peers (others incl. away ones), iceServers, resumed}`; broadcast `peer-joined` to others (not on resume).
3. Resume: `join{resume:true}` with a peerId that is away (or still attached on a stale socket): re-bind (close stale socket silently), clear away, `welcome{resumed:true}`, no broadcasts. Resume for an unknown peerId = fresh join.
4. `signal{to,data}` → forward `signal{from,data}` to `to` only; unknown/away target → `error{unknown-peer}` (non-fatal). Never parse/log `data`.
5. Close/error without `leave`: mark away, `awayUntil = now + RESUME_GRACE_SECONDS`, set alarm; `alarm()` removes expired peers → `peer-left{timeout}`; reschedule if others remain away. `leave` → immediate `peer-left{left}` + close.
6. Limits: raw message > MAX_MESSAGE_BYTES → `error{too-large}`; token bucket per socket (burst 200, 50 msg/s) → `error{rate-limited}`, close after sustained abuse.
7. ICE servers: STUN `stun:stun.cloudflare.com:3478` always; if `TURN_KEY_ID` + `TURN_KEY_API_TOKEN` set, mint via Cloudflare Realtime TURN API (check current docs via the cloudflare skills), TTL ~ 2 h, cache in DO memory ~ 10 min. Errors → fall back to STUN only.
8. Tests (`@cloudflare/vitest-pool-workers`, vitest 4 — already installed in signaling): join/welcome/peer-joined, relay isolation (C never sees A→B), room-full on 11th, version mismatch, duplicate-peer, resume within grace (no broadcasts), alarm timeout → peer-left, leave, bad JSON/oversize/rate limit, `/api/health`, bad room id 400, non-ws 426.
9. Replace `--passWithNoTests` in `signaling/package.json` once tests exist.
10. **Observability:** one JSON log line per room event (`{evt, room: roomId.slice(0,6), peer: peerId.slice(0,6), n, code?}`) — never names/SDP/keys/blobs. Dev telemetry: `wrangler.jsonc` top-level `vars.DEV_TELEMETRY = "1"` and `"0"` in staging/production envs; when "1": `GET /api/dev/config` → `{telemetry:true}`, `POST /api/dev/log` accepts `{peer, entries: LogEntry[], samples?: QaStatsSample[]}` (≤ 256 KB) and prints each entry as `[client <peer6>] <level> <scope> <msg> <data-json>` and each sample as a compact `[stats <peer6>] ...` line; when not "1" both return 404. Tests for both modes.
Acceptance: `make verify AREAS=signaling` green; `DEV_PORT=8788 make dev` + a node/ws or browser smoke shows two sockets exchanging a signal.

### B — Call engine · agent `rtc-engineer` · branch `pkg/rtc-core` · DEV_PORT 8789
Paths: `web/src/core/**` except `web/src/core/fake/**`, `types.ts`, `testids.ts`.
1. `signaling-client.ts`: WebSocket to `/api/room/<roomId>` (same origin, ws/wss by protocol); join/resume; heartbeat `ping` every HEARTBEAT_INTERVAL_MS; reconnect with jittered backoff (0.5 s → 8 s, give up after 60 s → `signaling-unavailable`); emits typed events; encrypts/decrypts via `@clearcall/protocol` `encryptSignal/decryptSignal` (drop undecryptable).
2. `peer-session.ts`: one RTCPeerConnection per remote peer; perfect negotiation (polite = smaller peerId); negotiated data channel `ctl` id 0; explicit transceivers for audio + video (sendrecv) created up front so camera on/off is `replaceTrack`/`sender.track=null` without renegotiation; candidate queueing; ICE restart policy per FLOWS.md; `bye` handling; status/quality derived from stats every 2 s.
3. `media.ts`: getUserMedia with voice/music constraints (webrtc-media skill), camera on/off (stop track when off so the camera light goes off), switch camera (facingMode toggle; `canSwitchCamera` via enumerateDevices), mic mute = `track.enabled=false`, `devicechange`, track `ended` recovery, `visibilitychange` re-acquire on iOS, audio level meter (one AudioContext + AnalyserNode for local only).
4. `sdp.ts`: Opus fmtp munging (`useinbandfec=1;usedtx=1;maxaveragebitrate=128000`), unit-tested on real-looking SDP from Chrome/Safari/Firefox.
5. `policy.ts`: ADR-0005 table + receiver `view` height + hidden-tab pause → `{maxBitrate, scaleResolutionDownBy, maxFramerate}` per connection; audio maxBitrate 32k voice / 96k music. Pure function, exhaustively unit-tested. Applied via `setParameters` read-modify-write, re-applied on participant count/view changes.
6. `codecs.ts`: codec preference (mediaCapabilities powerEfficient VP9 → H264 → VP8; RED first for audio when available), graceful fallback when APIs missing.
7. `controller.ts`: `createCallController(deps?)` implementing `CallController` exactly; phase machine idle→lobby→joining→in-call⇄reconnecting→ended/error; error mapping (NotAllowedError→permission-denied, NotFoundError/NotReadableError→no-devices, missing APIs/insecure context→unsupported, bad secret→invalid-link, server version→version-mismatch, room-full); active speaker with hysteresis (≥ 1.5 s hold); `audioBlocked` detection (play() rejection); Screen Wake Lock while in call; `shareLink` (navigator.share → clipboard); `leave` sends `leave` + ctl `bye` and stops tracks; `dispose`. New call: `prepare({})` generates a secret and `history.replaceState` to `/c#secret`.
8. `qa.ts`: install `window.__clearcall` (QaHook) when `?qa=1`; `stats()` summarizing getStats per QaPeerStats (missing fields undefined); MediaRecorder-based start/stopRecording of a remote stream.
9. **Transport seam (ADR-0006):** `transport/types.ts` defines `MediaTransport` (attach local tracks, per-participant remote streams/status/stats, apply policy, close) and `transport/mesh.ts` implements it with `peer-session.ts`. The controller only talks to `MediaTransport`. No SFU implementation yet — just keep the seam clean.
10. **Observability:** `log.ts` structured logger (`LogEntry` ring buffer 2000, levels, scopes; `console` mirror at warn+ and at debug when `?debug=1`) used by every module for every state transition (signaling connect/close/backoff, negotiation steps, ICE state changes, restarts, policy applications with values, media acquisition/errors, phase changes). `telemetry.ts`: if `GET /api/dev/config` says telemetry, batch-POST new log entries + stats samples to `/api/dev/log` every 2 s (and on pagehide via `sendBeacon`). `stats.ts`: 1 Hz sampler producing `QaStatsSample` (incl. encode/decode ms per frame, jitter buffer ms, kbps deltas, long tasks via PerformanceObserver, heap) kept in a 600-sample ring; feeds `quality` badges, active speaker and the QA hook. `qa.ts` implements the full `QaHook` incl. `inject()` faults.
11. Inject `WebSocket`, `RTCPeerConnection`, `mediaDevices`, `now/setTimeout`, `crypto` via a deps object so state machines are unit-testable with fakes. Write an in-memory fake signaling server for tests that wires N controllers together (no real WebRTC: fake RTCPeerConnection), covering join, leave, resume, room-full, glare.
Acceptance: `make verify AREAS=web` green; core has no imports from `src/ui`; unit tests cover policy, sdp, signaling reconnect, negotiation glare, controller phases.

### C — UI + PWA · agent `web-ui-engineer` · branch `pkg/ui` · DEV_PORT 8790
Paths: `web/src/ui/**`, `web/src/main.tsx`, `web/src/core/fake/**`, `web/index.html`, `web/public/**`, `web/vite.config.ts`, `e2e/tests/screens/**`.
Design: dark, calm, minimal (owner choice). Tokens in `src/ui/tokens.css`: background `#0b0d10`, surfaces `#14171c`/`#1c2027`, text `#f2f4f7` / muted `#9aa3ad`, one accent (calm teal-blue, e.g. `#4cc2ff`) used only for the primary action and the speaking ring, danger `#ff5a5f` only for Leave. 8 px spacing scale, radii 12/20/999, system font stack, 16 px base. Light theme for Home/Lobby only via `prefers-color-scheme`; call screen always dark.
Screens (all with testids from `testids.ts`):
1. **Home** `/`: wordmark "Clearcall", one-line promise ("Crystal-clear calls. Just share a link."), big primary **Start a call**, secondary "Have a link? Paste it" (input + Join). Nothing else.
2. **Lobby** `/c#…` before join: large preview (mirrored self-view; avatar initial when cam off), mic level meter, mic/cam toggles, name input (remembered in localStorage, placeholder "Your name"), primary **Join call**, and "Share link" so the host can invite before joining. Permission-denied / no-devices states inline with per-platform help (iOS: Settings › Safari › Camera; Android Chrome: lock icon › Permissions) and "Join without camera" when only camera fails.
3. **Call**: adaptive layout — 1 (alone: self large + "Waiting for others… Share link" card), 2 (remote full-bleed, self PiP draggable to corners, never covering center), 3–4 (2×2), 5–10 (grid, active speaker enlarged on wide screens). Tile: video or avatar initial, name label, muted mic icon, speaking ring (accent), poor-connection icon, "Can't connect · Retry" state. Controls bar bottom, thumb-reachable, auto-hide after 4 s of no touch in 2-party video (tap to show): mic, camera, flip (if canSwitchCamera), share, more (Music mode toggle with one-line explanation), Leave (danger). Top: participant count + call timer + reconnecting banner. "Tap to enable audio" overlay when `audioBlocked`. `ResizeObserver` → `controller.reportView(id, heightPx)`.
4. **Ended**: "Call ended" + duration, **Rejoin**, **New call**. **Error** screen for room-full, invalid-link, unsupported, signaling-unavailable, version-mismatch (reload button).
5. PWA: `vite-plugin-pwa` (already installed) manifest (name Clearcall, short_name Clearcall, display standalone, background/theme `#0b0d10`, icons 192/512/maskable + apple-touch-icon generated from an SVG mark — simple, calm: a rounded square with two overlapping circles or a soundwave); service worker caches app shell only, never `/api/*`, `navigateFallback` to index for `/c`. `web/public/_headers` with CSP (`default-src 'self'; connect-src 'self' wss: ; media-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'`), `Permissions-Policy: camera=(self), microphone=(self), display-capture=()`, `Referrer-Policy: no-referrer`. iOS install hint (after first call ends, Safari iOS only, not in standalone, dismissible, remembered).
6. `src/core/fake/`: `FakeCallController` implementing CallController with scenarios selectable by `?fake=1&scenario=<name>`: home, lobby, lobby-denied, lobby-nocam, call-1 … call-10, call-music-sheet, call-reconnecting, call-audio-blocked, call-peer-failed, ended, error-room-full, error-unsupported, error-invalid-link. Fake video = canvas `captureStream()` with a soft gradient + initial, so screenshots look realistic.
7. `main.tsx` chooses Fake vs real (`createCallController` from `src/core/controller.ts` — until package B merges, import must be guarded: use a dynamic import of `../core/controller.ts` behind a feature check, or depend only on the factory name `createCallController`; the orchestrator wires the final import at integration).
8. `e2e/tests/screens/screens.spec.ts`: iterate scenarios × {iPhone 15 (393×852 @3x), Pixel 7, 1440×900} → `quality/reports/screens/<scenario>-<device>.png`; then look at them (ui-verify) and iterate until polished.
Acceptance: `make verify AREAS=web` green; screenshots for every scenario reviewed; initial JS < 100 KB gzipped; Lighthouse-style basics (installable manifest, SW registered).

### D — Test & quality lab · agent `qa-engineer` · branch `pkg/qa` · DEV_PORT 8791
Paths: `e2e/**` except `e2e/tests/screens/**`; `quality/**` except `thresholds*.yaml` and `reference-media/`.
1. `e2e/lib/call.ts` helpers: `newParticipant(browser, name)` (own context; `?qa=1`), `startCall` (Home → Start → Lobby → Join, returns link), `joinCall(link)`, `waitConnected(page, n)`, `expectMediaFlowing(page)` (framesDecoded & bytesReceived increase for every remote over 2 s), `expectAudio(page)` (audioLevel > 0 at some sample).
2. Specs (Chromium; also enable Firefox/WebKit where fake media works and record why not where it doesn't): two-party call; 3- and 4-party mesh; 10-party (separate browser instances, longer timeout); mute/unmute reflected remotely (data-mic attr); camera off/on reflected; leave → others see peer removed; rejoin after leave; room-full for the 11th; reload mid-call (resume or rejoin) keeps call; signaling drop (use `page.context().setOffline` briefly on one peer or kill WebSocket via QA hook) → call survives; invalid link → error screen; permission denied → lobby error (context without permissions).
   These run against the integrated app later — they must typecheck now; it's expected they fail until packages A–C are merged. Do not `fixme` them; instead (tags removed after integration).
3. Quality lab v0 (`quality/src`): `prepare-media.ts` generates synthetic reference media into `quality/.cache/media/` with ffmpeg + macOS `say`: speech (several sentences via `say`, 48 kHz mono wav), speech+noise (mix with pink noise/babble at 10 dB SNR), music-ish (ffmpeg multi-tone/chord sequence), talking-head-ish video y4m 640×360@30 (testsrc2 + moving shapes) with a burned-in frame counter for alignment. `lab.ts --profile <name|all>`: read `profiles/*.yaml`; launch N Chromium instances with `--use-file-for-fake-video-capture/--use-file-for-fake-audio-capture`; drive the app via `?qa=1` (start/join via UI testids); collect `__clearcall.stats()` every second; record received media via the QA hook; compute VMAF (ffmpeg libvmaf, align by frame counter), PESQ-WB + DNSMOS via `uv run` Python (scorers/*.py with inline script deps), bitrate means/p95, freeze ratio, concealment ratio, RTT; write `reports/<ts>-<profile>/report.{json,md}`; compare against `thresholds.yaml` if present else `thresholds.proposed.yaml` (clearly marked "proposed"); exit 1 on breach. `compare.ts` diffs two reports.
4. Network shaping: `quality/netem/` Dockerfile + compose based on the official Playwright image with `iproute2`, `cap_add: NET_ADMIN`, applying `tc qdisc ... netem` per profile (delay/jitter/loss/rate, schedule for `bw_squeeze`); the lab runs peers inside containers when `--netem` is passed (requires Docker running; detect and explain if not). Unshaped local runs are allowed for development and labelled "unshaped".
5. **Diagnostics tool** `make diag N=4 DURATION=60 [PROFILE=…]` (add the Makefile target + `scripts/diag.sh` calling `quality/src/diag.ts`): launches N headless Chromium participants (fake media) on the running dev stack with `?qa=1`, joins one call, runs DURATION seconds (optionally injecting faults via `--fault drop-signaling@20s`), then writes `quality/reports/diag-<ts>/`: `peer-<i>/logs.json`, `peer-<i>/timeline.json`, `peer-<i>/console.txt`, `peer-<i>/screenshot.png`, `cpu.json` (CDP `Performance.getMetrics` TaskDuration deltas per browser), `worker.log` (slice of dev-server.log for the run window), and `summary.md` with per-peer tables (time-to-connect, time-to-first-frame, mean/p95 kbps, RTT, loss, freezes, encode ms/frame, long tasks) and an **Anomalies** list (never connected, freezes > 1 %, bitrate < 50 % of policy target for > 10 s, encode > 20 ms/frame, any error-level log, page errors). Exit non-zero on hard anomalies.
6. E2E helpers capture every participant's console messages, page errors and failed requests and attach them to the test result (`testInfo.attach`) so failures are debuggable without traces.
7. Unit tests (vitest) for profile parsing, threshold evaluation, report diffing, frame-counter alignment math.
Acceptance: `make verify AREAS="e2e quality"` green; `pnpm --filter @clearcall/quality exec tsx src/prepare-media.ts` produces media; lab code typechecks and its pure parts are tested.

## Integration (orchestrator, after merges) — W2
Wire `main.tsx` to the real controller; `make dev`; run the E2E suite; fix; screenshots; first quality run bot↔bot.

## Acceptance criteria for squash-merge to main
0. `make diag N=4 DURATION=30` produces a bundle with zero hard anomalies; dev-server.log shows interleaved client + server telemetry.
1. `make verify` green on all areas.
2. `make e2e ARGS="--project=chromium"` green including 2/3/4/10-party, mute/cam, leave/rejoin, room-full, signaling drop, invalid link.
3. `make screenshots` reviewed: all scenarios polished at iPhone/Pixel/desktop.
4. `make quality PROFILE=good_wifi` (unshaped acceptable) produces a report with VMAF, PESQ, bitrate, freezes.
5. Initial JS < 100 KB gzipped.

## Risks
iOS Safari autoplay/background camera (handled in B, verified on device in W5) · Firefox/WebKit fake media in Playwright (document gaps) · 10-party mesh CPU on one laptop (use separate browser instances, generous timeouts) · TURN untestable locally without secrets (STUN-only path tested).

## Integration backlog (orchestrator)
- testids: add `retryMedia`, `installHintDismiss`, `sheetClose`, `errorAction` (UI currently reuses `rejoinButton` on Error); document `data-mic`/`data-cam` = "true"/"false", self tile `data-participant-id="self"`.
- Lobby with both devices blocked: preview collapses to a strip of disabled icons — show a proper avatar card instead.
- 10-up on short phones (393×659): self tile alone in last row — consider 2×5 or self as PiP.
- Confirm CSP `connect-src 'self'` permits same-host WebSocket in Chromium/WebKit/Firefox E2E.

## Findings from first live calls (orchestrator, 2026-10-11)
- ✅ Real 2-, 4- and 10-party Chromium calls through the real Worker: connected + media flowing within ~2–5 s (10-party full mesh, 90 directed streams, one headless Chromium).
- 🐞 Fixed: Join tapped before lobby getUserMedia resolved → no media sent (fix/join-before-media, regression test).
- 🐞 Fixed: QA probes and the 1 Hz sampler shared stats baselines → 0 / absurd kbps (fix/stats-consumers, regression test).
- 📈 Media lead (W4, media-engineer, measure first): 2-party ramp 180p→720p takes ~16 s from GCC's 300 kbps start on an unconstrained link. Try a higher start bitrate (e.g. `x-google-start-bitrate` on video fmtp / higher initial `maxBitrate` budget) and measure time-to-720p, plus overshoot on `3g_lossy` and `bw_squeeze`.
- 📈 Fake-device capture runs at 20 fps; use file-fed 30 fps media in the lab for fps-sensitive metrics.
- 🔥 10 separate Chromium processes thermally throttle the host → Room declared all sockets dead (4006) → offers lost → pairs failed. Fixed server cutoff (2→4 heartbeats); engine resilience (lost-offer rebuild, don't give up signaling while media flows) and E2E capacity restructuring in progress.
- 🧪 First integrated E2E: 9/15 pass; remaining are test-harness issues (auto-hidden controls, capacity setup, permission-denied setup) + product rule `/c` without secret → invalid-link.
- ✅ Engine resilience merged (lost-offer/answer rebuild, keep reconnecting while pairs live, resume rebuilds unhealthy pairs, chaos tests; real diag with all-peer signaling drop: 0 hard anomalies).
- 🔧 Follow-up: client heartbeat cutoff is 2×+5 s (35 s) vs server 4× (60 s) — align (client detects dead socket via missing pong; consider ~45 s) and measure reconnect latency in diag.
- 🔧 Follow-up: verify duplicate-offer re-send / stray-answer handling in WebKit + Firefox E2E.
