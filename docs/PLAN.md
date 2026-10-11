# Plan & status — Clearcall V1 (web)

Agents: read at the start of non-trivial work; update Status and the Log when you finish something.
Per-feature plans: `docs/plans/<slug>.md`.

## Milestones
| # | Milestone | Exit criteria | Status |
|---|---|---|---|
| W0 | Harness + workspace + contracts | web-focused hooks/skills/agents; pnpm workspace builds; `protocol/` + `web/src/core/types.ts` agreed | done |
| W1 | Parallel build | signaling Worker · WebRTC core · UI/PWA shell (on FakeCallController) · E2E + lab + diag — each green on its branch | done |
| W2 | Integration: first real call | 2 Chromium peers call each other via `make dev`; `make e2e` 2/3/4-party green | done |
| W3 | Robustness | reconnect/resume, ICE restart, room full, permissions errors, 10-party E2E, WebKit + Firefox E2E | mostly done (ghost-peer + cam-mute fix in progress) |
| W4 | Quality | lab runs on all profiles; music mode; codec/RED/start-bitrate decisions from data; thresholds revised + adopted | done except shaped (netem) profiles + owner threshold adoption |
| W5 | Owner device test + deploy | owner `wrangler login`; staging deploy; iPhone + Android real-device checklist incl. background-audio spike | todo |
| W5b | SFU transport (ADR-0006) | Cloudflare Realtime SfuTransport behind MediaTransport; room switches mesh→SFU under load; group_10 gates | todo (needs owner Cloudflare Realtime creds) |
| W6 | V1.1 | ML noise suppression (if lab proves it), install hint polish, ringing via Web Push (design TBD) | todo |

## Open decisions (owner)
- Cloudflare login for deploy (owner runs `! npx wrangler login` when ready)
- Adopt quality thresholds v2 (data-derived): `mv quality/thresholds.proposed.yaml quality/thresholds.yaml`
- Tier 3–4 video cap 600 → 800 kbps? (+6–7 VMAF, +32 % upload)
- Docker Desktop storage is broken (multi-layer images fail: 'too many levels of symbolic links'); netem lab blocked until restarted/repaired. Agents pulled playwright:v1.64.0-noble (2.47 GB) + ubuntu:24.04 — owner may remove.

## Log
- 2026-10-11 — Harness scaffolded (native-first), then refocused to web-only V1. Name: Clearcall. Style: dark, calm, minimal. Local git only.
- 2026-10-11 — Plan review (7 blockers fixed in contracts); owner asked for squash-merge policy, full agent autonomy + observability, hybrid mesh/SFU (ADR-0006). W1 agents launched from 6ef1f12.
- 2026-10-11 — V1 core squash-merged: real 2–10 party calls, 17/17 Chromium E2E (+Firefox/WebKit 2–3 party), diag N=4 0 hard anomalies, first quality report (good_wifi unshaped: VMAF 81.5, DNSMOS BAK 2.48→3.68 from NS, TTFF 848 ms). Threshold compliance moved to W4 (proposed PESQ/kbps gates need revision).
- 2026-10-12 — W4 squash-merged: good_wifi VMAF 81.5→85.5 at same 1.52 Mbps (lab recorder fix + AV1 for 1:1), 720p ramp 17.5→5.4 s, VP8 for 3–10 (CPU), music mode stereo Opus +16 dB SNR, voice defaults kept (ADR-0007), thresholds v2 proposed. Found pre-existing Firefox 3-party intermittent media stall (2/4 on main) — investigating.
