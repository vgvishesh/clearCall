# Plan & status — Clearcall V1 (web)

Agents: read at the start of non-trivial work; update Status and the Log when you finish something.
Per-feature plans: `docs/plans/<slug>.md`.

## Milestones
| # | Milestone | Exit criteria | Status |
|---|---|---|---|
| W0 | Harness + workspace + contracts | web-focused hooks/skills/agents; pnpm workspace builds; `protocol/` + `web/src/core/types.ts` agreed | in progress |
| W1 | Parallel build | signaling Worker · WebRTC core · UI/PWA shell (on FakeCallController) · E2E + lab scaffolding — each green on its branch | todo |
| W2 | Integration: first real call | 2 Chromium peers call each other via `make dev`; `make e2e` 2/3/4-party green | todo |
| W3 | Robustness | reconnect/resume, ICE restart, room full, permissions errors, 10-party E2E, WebKit + Firefox E2E | todo |
| W4 | Quality | lab runs bot↔bot on all profiles; music mode; codec/RED decisions from data; thresholds adopted | todo |
| W5 | Owner device test + deploy | owner `wrangler login`; staging deploy; iPhone + Android real-device checklist incl. background-audio spike | todo |
| W6 | V1.1 | ML noise suppression (if lab proves it), install hint polish, ringing via Web Push (design TBD) | todo |

## Open decisions (owner)
- Cloudflare login for deploy (owner runs `! npx wrangler login` when ready)
- Adopt quality thresholds: `mv quality/thresholds.proposed.yaml quality/thresholds.yaml`

## Log
- 2026-10-11 — Harness scaffolded (native-first), then refocused to web-only V1. Name: Clearcall. Style: dark, calm, minimal. Local git only.
