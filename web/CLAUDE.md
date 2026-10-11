# web/ — Clearcall PWA (Vite + Preact + signals + TS)
Load `web-dev`. `src/core` = engine (rtc-engineer), `src/ui` = screens (web-ui-engineer); they meet only at `src/core/types.ts` (CallController) and `src/core/testids.ts`.
Use `?fake=1&scenario=<name>` to run the UI on FakeCallController; `?qa=1` exposes `window.__clearcall` for tests.
