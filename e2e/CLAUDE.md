# e2e/ — Playwright
Load `browser-test`. Runs against `make dev` (worker on :8787 serving the built app). Projects: `chromium` (default, fake media), `firefox`, `webkit`, `screens` (screenshot suite on iPhone/Pixel/desktop). One browser context per participant; poll stats via `window.__clearcall`, no fixed sleeps.

- Write call specs with `test` from `lib/fixtures.ts` (the `call` fixture creates participants and attaches every participant's console, page errors, failed requests, QA logs and stats timeline) and helpers from `lib/call.ts` (`setupCall`, `waitConnected`, `expectMediaFlowing`, `expectAudio`).
- Click call-dock controls with `clickControl(page, TID.x)` (or `showControls(page)` first): in a 2-party video call the dock auto-hides after 4 s.
- Projects: `chromium`/`firefox`/`webkit` run every spec except `call-large`; the `capacity` project (10-party, room-full; one Chromium with one context per peer, 1 worker) is their `teardown`, so it runs after them, alone. `make e2e ARGS="--project=chromium"` therefore includes capacity; add `--no-deps` to skip it while iterating, or `--project=capacity` to run only it.
- Permission-denied needs the full Chromium (`channel: "chromium"`, new headless): the default headless shell has no permission prompt and rejects getUserMedia with NotSupportedError.
