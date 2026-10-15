# 0011 — Ask for camera/mic only after a tap, coach per browser, route in-app browsers out

- Status: Accepted (owner asked for the fix 2026-10-15; this records the engineering choices)
- Date: 2026-10-15

## Context
V1 requirement 1: "others tap the link → in the call". Owner field report (2026-10-15): people, mostly older and
not tech-native, open the shared link in their phone's default browser or in a messaging app's own browser. They
get stuck at the camera/mic prompt.
- The lobby called getUserMedia on page load, so the browser prompt appeared before the person knew what the page
  was. A cautious "Block" is sticky: Chrome stops asking, and iOS needs Settings.
- The recovery help was one line of text for three platforms. It was wrong for Samsung Internet, Xiaomi's browser,
  Chrome on iOS, the iOS home-screen app and in-app browsers.
- Some in-app WebViews can't do getUserMedia at all (Facebook/Instagram on Android), or never resolve it.

## Decision
1. **Tap-gated prompt.** `prepare()` acquires media only when the Permissions API already says camera AND mic are
   "granted". If either is "denied", it goes straight to the blocked help with no getUserMedia call. Otherwise the
   lobby shows a "Get ready" step: what's about to happen, a picture of this browser's prompt with Allow
   highlighted, then "Turn on camera & mic" (`requestMedia()`).
   - Exception: Home → "Start a call" is already a deliberate tap, so it calls `requestMedia()` straight away.
2. **The app never re-prompts on its own.** Auto re-acquire only happens after `permissions.query` reports
   "granted": on a change event, or on becoming visible again after Settings.
   - One tap ≤ one prompt: no per-device fallback getUserMedia calls after a NotAllowedError. Chrome auto-blocks a
     site for 7 days after 3 dismissals.
3. **Per-browser help.** A data-driven UA table (`web/src/ui/platform.ts`) picks 3 large numbered steps for the
   exact browser:
   - iOS Safari, iOS home-screen app, Chrome on iOS
   - Chrome Android, Samsung Internet, Xiaomi, Firefox
   - desktop browsers

   UA sniffing is used for copy only, never for capability decisions.
4. **In-app browsers are sent out.** Detected in-app or WebView UAs get "Open in Chrome" plus "Copy link" (Android
   `intent://…#secret#Intent;…;end`; `Intent.parseUri` splits on the last `#`), or Safari guidance on iOS
   (`x-safari-https` on iOS ≥ 17).
   - The room secret stays in the URL fragment in every hop. It never moves to the path or query (ADR-0004).
   - A prompt still "asking" after 20 s offers the same way out.
5. **No dead end.** "Join with sound only" (`requestMedia({video:false})`) and "Join and just listen" stay
   available. Tapping mic/cam in the call later asks for just that device.
6. **Privacy.** Telemetry and QA logs carry only the detected browser class. Never the UA string, never the secret.

## Alternatives considered
- **Keep the prompt on load, improve only the blocked help.** Most of the damage is the first, unexplained "Block".
- **Native app or app-store install.** Out of scope for V1 (ADR-0003, web-only).
- **Moving the secret into the query string so it survives redirects.** It would reach the Worker, which breaks
  ADR-0004.
- **Feature-detecting in-app browsers instead of using UAs.** They expose getUserMedia and fail only at call time.
  SFSafariViewController can't be told apart at all, which is why the 20 s "asking" timeout exists.

## Consequences
- **Costs:**
  - One extra tap for joiners whose browser hasn't granted access yet. Safari without a saved "Allow" asks every
    visit.
  - The UA table needs upkeep as apps change their UAs. It's small, data-driven and unit-tested.
- **Signals it's wrong:**
  - Real-device reports of people stuck on Get ready.
  - The intent link losing `#secret`, which is on the owner's real-device checklist.
  - Joiners landing listen-only who meant to talk.
- **Reverse:** `prepare()` can acquire immediately again. One branch in the controller; the coach UI stays as
  blocked-help.
