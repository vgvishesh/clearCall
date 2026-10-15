# Permission coach — get non-technical users through camera/mic permission

Owner request 2026-10-15: people (often older, non-tech-native) open the shared link in their phone's default
browser and get stuck: they tap Block on a prompt that appears on page load, can't find where to re-enable it, or
land in a browser that can't call. Serves V1 requirement 1 (tap the link → in the call) and 4 (works on iPhone
Safari / Android Chrome).

## Behaviour
1. **Get ready step, prompt only after a tap.** Opening a link (or Start a call) goes to the lobby without calling
   getUserMedia unless the Permissions API already reports camera AND microphone "granted". The lobby shows a
   large, calm "Get ready" card: one sentence ("Your phone will ask to use the camera and microphone. Tap
   **Allow**."), an inline-SVG picture of that browser's prompt with the Allow button highlighted, and a big
   "Turn on camera & mic" button → `requestMedia()`. While `mediaRequest === "asking"`: "Tap Allow" with an arrow
   toward where that browser shows its prompt (top on iOS Safari/Chrome Android, bottom sheet on some).
2. **Blocked → illustrated steps for this exact browser.** 3 big numbered steps (text + small inline SVG glyphs)
   per browser: iOS Safari (aA menu › Website Settings › Allow; and Settings › Safari › Camera/Microphone),
   iOS Chrome / other iOS (Settings › Chrome › Camera/Microphone), Android Chrome (lock/tune icon › Permissions),
   Samsung Internet, Xiaomi/MIUI browser, Firefox Android, desktop Chrome/Safari/Firefox/Edge. Big
   "I've done it — try again" button (`requestMedia()`). Controller auto-retries when Permissions API `change` →
   granted and when the page becomes visible again while blocked (back from Settings).
3. **Open in the right browser.** UA detection of in-app / unsupported browsers (WhatsApp, Instagram, Facebook,
   Messenger, Snapchat, LinkedIn, Line, Telegram on Android, generic Android WebView `; wv)`), and the existing
   `unsupported` error. Android: big "Open in Chrome" button using `intent://<host><path>#Intent;scheme=https;
   package=com.android.chrome;S.browser_fallback_url=<url>;end` (keeps the `#secret` fragment — verify; if the
   fragment can't survive intent URLs, fall back to "Copy link" + instruction). iOS: picture of "⋯ / Share › Open
   in Safari" + "Copy link" button. Shown as a lobby notice when the browser can still try, as the error screen
   when it can't (`unsupported`).
4. **Never a dead end.** Join buttons "Join with sound only" (no cam) / "Join and just listen" (no cam + mic) are
   always available below the coach; a secondary "Join without camera & mic" link is visible on the Get ready step.
5. **Senior-friendly copy and size.** Coach screens use ≥ 18 px body text, ≥ 56 px primary buttons, plain words
   (no "permissions", "WebRTC"), one action per screen.

## Contract (landed first on feat/permission-coach)
- `web/src/core/types.ts`: `MediaRequest = "not-asked" | "asking" | "done"`, `LocalParticipant.mediaRequest`,
  `CallController.requestMedia()`; `prepare()` no longer prompts unless already granted.
- `web/src/core/testids.ts`: `permissionPrime`, `allowMedia`, `permissionHelp`, `openInBrowser` (+ existing
  `retryMedia`).
- FakeCallController: `requestMedia()` with `askDelayMs` / `denyMedia` options; `mediaRequest` default "done".
- No protocol/ or signaling/ change.

## Work packages (disjoint paths; worktrees cut from feat/permission-coach)
| Pkg | Agent | Paths | Tasks |
|---|---|---|---|
| A core | rtc-engineer | `web/src/core/**` except `fake/` and `types.ts`/`testids.ts` | deferred acquisition in `prepare` (Permissions API query camera+microphone; Safari/Firefox may throw for "camera" → treat as unknown → not-asked); real `requestMedia()` (replaces the stub; also used for retry, no teardown/new link); `mediaRequest` transitions; auto-retry on permission `change` → granted and on `visibilitychange` visible while blocked (debounced, only when mediaRequest done + permission-denied); join from not-asked joins without media (listen-only) and a later `requestMedia()` in-call hands tracks to the transport; QA log lines. Unit tests in controller/media tests. |
| B ui | web-ui-engineer | `web/src/ui/**`, `web/src/core/fake/scenarios.ts`, `web/src/core/fake/FakeCallController.ts` | `platform.ts` `detectBrowser()` (unit-tested UA table incl. Samsung, MIUI, in-app, iOS Chrome); Lobby coach states (prime / asking / blocked help / in-app notice); ErrorScreen `unsupported` → open-in-browser; App no longer assumes media on load; copy in `copy.ts`; inline-SVG illustrations (no images/deps); fake scenarios `lobby-ask`, `lobby-asking`, `lobby-blocked-<browser>`, `lobby-inapp-android`, `lobby-inapp-ios`, `error-unsupported-inapp`; screenshots via `make screenshots` reviewed at iPhone + Android + desktop. |
| C e2e | qa-engineer | `e2e/**` | `e2e/tests/permissions.spec.ts`: (1) fresh context without permissions → prime visible, no getUserMedia before tap (instrument via init script), tap allow (grant) → preview → join → 2-peer call exchanges media; (2) granted context → no prime, straight preview (existing flows keep working); (3) denied → help visible with retry, grant + "I've done it" → preview; (4) join with sound only/listen-only from prime → 2-peer call, remote hears audio; (5) in-app UA (WhatsApp Android UA via context userAgent) → open-in-browser button with an intent:// href carrying the fragment. Update existing specs/helpers that assume media starts on load. Screen scenarios added to `e2e/tests/screens/scenarios.ts`. |

## Acceptance criteria
- `make verify` green; unit tests for detectBrowser, deferred acquire, requestMedia, auto-retry.
- `make e2e` Chromium green incl. `permissions.spec.ts` (≥ 2 real peers exchanging media in cases 1 and 4); WebKit +
  Firefox call-basic still green where the host can launch them.
- `make screenshots`: coach states reviewed at iPhone, Pixel and desktop sizes (large text, one primary action,
  fits without scroll on iPhone SE height).
- Bundle stays < 100 KB gzip initial.

## Risks
- iOS Safari: Permissions API `camera` query supported since 16; older throws → treated as not granted → one extra
  tap. iOS asks again every page load unless "Allow" was set in Website Settings — the extra tap is the price.
- Firefox doesn't support querying "camera" → always prime (one tap).
- Android intent URLs: fragment preservation varies; must verify, else copy-link fallback.
- In-app browser UA lists drift; keep the table small and data-driven.
- Can't automate Samsung Internet / MIUI / real in-app browsers → owner real-device check listed in PLAN.

## Review round 1 (plan-evaluator) — resolutions (binding for all packages)
1. **Sound only:** contract is now `requestMedia(opts?: { video?: boolean })`. Get ready step = one primary
   ("Turn on camera & mic") + one secondary link ("Join with sound only" → `requestMedia({video:false})`, tid
   `joinSoundOnly`). Listen-only = the existing `joinButton` labelled "Join and just listen" when no device is
   granted. In a call, tapping mic/cam for a never-granted device → `requestMedia({video: kind==="video"})`; a late
   cam grant never turns the mic on and vice versa. Fake mirrors this.
2. **Test ids:** `joinSoundOnly`, `inAppNotice`, `openInBrowser` (lobby notice AND unsupported error screen),
   `copyLink` (always beside openInBrowser).
3. **No prompt without a tap (A):** auto re-acquire only when `permissions.query` says "granted" (change event, or
   on visible after a query); no query API → no auto-retry. `acquire()` skips its per-device getUserMedia fallbacks
   after a combined NotAllowedError unless a device reports "granted" (one tap = at most one prompt; Chrome's
   3-dismiss auto-block). `requestMedia()` while "asking" is a no-op. Unit tests for each.
4. **Intent URL (B):** builder `intent://<host><path>#<secret>#Intent;scheme=https;package=com.android.chrome;
   S.browser_fallback_url=<percent-encoded full https URL>;end` (Intent.parseUri splits on the LAST `#`). Unit
   test: fragment kept, fallback encoded, `#Intent;` last. The secret NEVER moves to path or query (ADR-0004).
   "Copy link" always shown next to it. Real-device check "intent opens Chrome with #secret intact" → PLAN.
5. **E2E helpers (C owns `e2e/lib/**`):** the shared join helper taps `allowMedia` only if visible. call-basic on
   Firefox and WebKit is an acceptance gate (run in the lab Docker image if the host can't launch them).
6. **Lab/diag:** `make diag N=2 DURATION=20` smoke in acceptance (granted path). Not a media change → no metrics.
7. **iOS after Block (B+A):** if "I've done it" still gets NotAllowedError on iOS, show a big "Reload page" (URL is
   canonical `/c#secret`). Home-screen app (standalone) gets Settings › Safari › Camera/Microphone steps, not aA.
8. **iOS in-app:** offer `x-safari-https://…` link on iOS ≥ 17 + Copy link. "asking" longer than 20 s → "Having
   trouble? Open in Safari/Chrome" (webviews that never resolve getUserMedia).
9. **Precedence:** in-app detected → open-in-browser, never lock-icon steps. Telegram/LinkedIn (Custom Tabs) are
   NOT flagged. UA table is data + unit-tested.
10. **Denied on load:** `prepare()` → mediaRequest "done" + permission-denied, no getUserMedia → blocked help directly.
11. **Late tracks (A):** unit test join with null tracks → grant → replaceTrack on every pair, no new offer. `join()`'s
    mediaReady wait applies only while "asking". After a late mic grant on iOS, re-`play()` remote audio elements.
    E2E case 4: listen-only joiner hears the host; sound-only joiner is heard by the host.
12. **Caller one-tap:** Home "Start a call" calls `requestMedia()` right after `prepare({})` from the same gesture.
13. **unsupported error has no `state.link`:** use `location.href` when it's a `/c#` link; Home→Start in an
    unsupported browser shows browser advice only.
14. **ADR-0011** (orchestrator): tap-gated permission + UA detection of in-app browsers. Telemetry logs only the
    browser class, never the UA string or secret.
15. **E2E case 3:** assert end state (auto-retry may beat the tap). Denied tests: one full-Chromium process max.
