# e2e/ — Playwright
Load `browser-test`. Runs against `make dev` (worker on :8787 serving the built app). Projects: `chromium` (default, fake media), `firefox`, `webkit`, `screens` (screenshot suite on iPhone/Pixel/desktop). One browser context per participant; poll stats via `window.__clearcall`, no fixed sleeps.
