---
name: web-dev
description: Develop the Clearcall web app (Vite + Preact + signals + TypeScript PWA) — project layout, commands, component/style conventions, PWA and mobile-browser (iOS Safari / Android Chrome) quirks for calling apps. Use for any work under web/.
---
# web-dev

## Commands
`make dev` (build + worker on :8787, the only way to test real calls — Vite alone has no signaling) · `pnpm --filter @clearcall/web dev` (Vite HMR on :5173 for pure UI work against `?fake=1`, which swaps in FakeCallController) · `make web-test` · `make screenshots`.

## Layout
- `src/core/` — call engine. No Preact/DOM-rendering imports. Entry: `createCallController()` implementing `CallController` from `src/core/types.ts`.
- `src/ui/` — screens/components. Talks only to `CallController` (via `useCall()` context). Never touches `RTCPeerConnection`/`getUserMedia` directly.
- `src/ui/tokens.css` — all colors/spacing/radii/typography as CSS custom properties. No hard-coded colors in components.
- Routing: `/` Home, `/c#<secret>` Lobby→Call→Ended. Hash changes never hit the server.
- Tests next to code: `*.test.ts(x)` (Vitest + happy-dom for UI, plain for core).

## Conventions
- State: `@preact/signals`. Controller exposes `state: ReadonlySignal<CallState>`; UI derives with `computed`.
- Every interactive element has a `data-testid` from `src/core/testids.ts` (the E2E contract) and an accessible label.
- Tap targets ≥ 48px; controls reachable with one thumb; respect `env(safe-area-inset-*)`.
- Bundle budget: < 100 KB gzipped initial JS. Check `pnpm --filter @clearcall/web build` output.

## Mobile browser quirks (calling)
- `getUserMedia` needs a secure context (https or localhost) and on iOS a user gesture for the first play of remote audio → acquire media from the Lobby "Join" tap.
- `<video autoplay playsinline muted>` for local preview; remote `<video autoplay playsinline>` and call `.play()` after join; catch `NotAllowedError` and show a "Tap to enable audio" overlay.
- iOS: camera track is stopped/muted when the app is backgrounded → on `visibilitychange` visible, check `track.readyState`/`muted` and re-acquire + `replaceTrack`.
- iOS PWA (home-screen) and Safari share WebRTC but not storage. No `navigator.vibrate`, no `setSinkId` on iOS.
- Screen Wake Lock (`navigator.wakeLock.request('screen')`) during calls; re-request on visibility regain.
- Use `100dvh`, not `100vh`.
