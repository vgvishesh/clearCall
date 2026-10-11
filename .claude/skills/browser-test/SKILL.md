---
name: browser-test
description: Drive and test Clearcall in real browsers — Playwright E2E suites with fake/file media and multiple participants, Playwright MCP or the Claude in Chrome extension for interactive checks, mobile emulation, and reading WebRTC stats from the page. Use when writing E2E tests, debugging a call in a browser, or checking behavior interactively.
---
# browser-test

## Which tool
- **Automated, repeatable (default):** Playwright test in `e2e/tests/*.spec.ts`, run with `make e2e`. Multi-participant = multiple `browser.newContext()`s in one test.
- **Interactive exploration / debugging:** Playwright MCP (`mcp__playwright__*`, isolated, supports device emulation) or Claude in Chrome (`mcp__claude-in-chrome__*`, the owner's real Chrome — load the `claude-in-chrome` skill first; open new tabs, never reuse the owner's). Anything found interactively becomes a Playwright test.

## Media in tests
- Chromium flags: `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` (synthetic video + beep). For quality: `--use-file-for-fake-video-capture=<y4m> --use-file-for-fake-audio-capture=<wav>`.
- Firefox prefs: `media.navigator.streams.fake: true`, `media.navigator.permission.disabled: true`.
- WebKit: grant `camera`/`microphone` permissions in the context; mock capture devices support may vary — if a WebKit test can't get media, mark it with a clear reason in the report, don't silently skip.
- Each participant must be its own browser context (separate storage), ideally separate browser instances for >4 peers to avoid shared-process CPU skew.

## Assertions that prove a call works
Use the QA hook (`/c?qa=1#<secret>`): `window.__clearcall.state()` and `await window.__clearcall.stats()` → per-peer `{ connectionState, bytesReceived, framesDecoded, audioLevel, candidateType, rtt }`.
- Connected: every peer `connectionState === "connected"` within 15 s.
- Media flowing: `framesDecoded` and `bytesReceived` strictly increase over 2 s for every remote peer.
- Audio: `audioLevel > 0` at some sample (fake device emits a beep).
Poll with `expect.poll`, never fixed sleeps.

## Mobile emulation
Projects for `iPhone 15` (WebKit) and `Pixel 7` (Chromium) viewports exist for layout/screens tests. Emulation ≠ real device; real-device checks go to the owner via `make tunnel`.
