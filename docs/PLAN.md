# Plan & status — Clearcall V1 (web)

Agents: read at the start of non-trivial work; update Status and the Log when you finish something.
Per-feature plans: `docs/plans/<slug>.md`.

## Milestones
| # | Milestone | Exit criteria | Status |
|---|---|---|---|
| W0 | Harness + workspace + contracts | web-focused hooks/skills/agents; pnpm workspace builds; `protocol/` + `web/src/core/types.ts` agreed | done |
| W1 | Parallel build | signaling Worker · WebRTC core · UI/PWA shell (on FakeCallController) · E2E + lab + diag — each green on its branch | done |
| W2 | Integration: first real call | 2 Chromium peers call each other via `make dev`; `make e2e` 2/3/4-party green | done |
| W3 | Robustness | reconnect/resume, ICE restart, room full, permissions errors, 10-party E2E, WebKit + Firefox E2E | done |
| W4 | Quality | lab runs on all profiles; music mode; codec/RED/start-bitrate decisions from data; thresholds revised + adopted | done except shaped (netem) profiles (thresholds v2 adopted 2026-10-12) |
| W5 | Owner device test + deploy | owner `wrangler login`; staging deploy; iPhone + Android real-device checklist incl. background-audio spike | todo |
| W5b | SFU transport (ADR-0006) | Cloudflare Realtime SfuTransport behind MediaTransport; room switches mesh→SFU under load; group_10 gates | todo (needs owner Cloudflare Realtime creds) |
| W6 | V1.1 | ML noise suppression (if lab proves it), install hint polish, ringing via Web Push (design TBD) | todo |

## Open decisions (owner)
- TURN: optional by design (owner, 2026-10-12: not enabled on our staging). Any deployer enables it with `make turn-setup` + `make turn-check` (docs/SETUP.md).
- (decided 2026-10-12) Tier 3–4: owner wants BOTH 600 and 800 kbps, switched per user by available bandwidth — implemented on feat/adaptive-tier-cap (ADR-0008); netem bw_squeeze/3g_lossy at 3 participants still to run.
- Docker restarted by owner 2026-10-12: general images run; playwright base image still fails (overlay "too many levels of symbolic links") — netem image being rebuilt on ubuntu base (chore/netem-unblock).

## Log
- 2026-10-11 — Harness scaffolded (native-first), then refocused to web-only V1. Name: Clearcall. Style: dark, calm, minimal. Local git only.
- 2026-10-11 — Plan review (7 blockers fixed in contracts); owner asked for squash-merge policy, full agent autonomy + observability, hybrid mesh/SFU (ADR-0006). W1 agents launched from the reviewed contracts (squashed into c9f3577).
- 2026-10-11 — V1 core squash-merged: real 2–10 party calls, 17/17 Chromium E2E (+Firefox/WebKit 2–3 party), diag N=4 0 hard anomalies, first quality report (good_wifi unshaped: VMAF 81.5, DNSMOS BAK 2.48→3.68 from NS, TTFF 848 ms). Threshold compliance moved to W4 (proposed PESQ/kbps gates need revision).
- 2026-10-12 — W4 squash-merged: good_wifi VMAF 81.5→85.5 at same 1.52 Mbps (lab recorder fix + AV1 for 1:1), 720p ramp 17.5→5.4 s, VP8 for 3–10 (CPU), music mode stereo Opus +16 dB SNR, voice defaults kept (ADR-0007), thresholds v2 proposed. Found pre-existing Firefox 3-party intermittent media stall (2/4 on main) — investigating.
- 2026-10-12 — Firefox 3-party stall fixed: Firefox H264 sender stalls on mid-call resolution change; Gecko now ignores its H264 power-efficient claim (VP8/AV1 per tier), impolite-only re-offer on tier change. Firefox call-basic 20/20, Chromium 15/15, WebKit 6/6. Untested: Firefox paired with Safari/Chrome-HW-H264 (could still pick H264).
- 2026-10-12 — Firefox reload flake fixed: Firefox never settles a getStats pending when its pc closes (ghost pair dropped after reload) → hung stats() and would stop the stats sampler mid-call in production. PeerSession rejects pending getStats on close/rebuild. Firefox reload 60/60 (was 25/30).
- 2026-10-12 — Staging deployed: the staging Worker (workers.dev) (STUN only until TURN secrets set). E2E against staging: call-basic Chromium 3/3, Firefox 2/2, WebKit 2/2; full Chromium 15/15 (an earlier run at load avg 74 had 4 load-induced failures).
- 2026-10-12 — Adaptive 600/800 send level merged (ADR-0008): 3-party VMAF 68.4→73.9 for +27 % upload. Netem lab works (uplink-only). First shaped runs (main 605ca1b, 1 run each): 4g VMAF 86.7 freeze 3.3 %; high_rtt 86.6 freeze 3.6 %; bw_squeeze 90.3 freeze 10.6 %, recovery 30 s; **3g_lossy VMAF 42 freeze 22 % (3-party 28)** — Chrome BWE collapses to ~100 kbps on a 400 kbps link with 5 % loss. All profiles breach thresholds (TTFF partly a lab artefact). Fix in progress.
- 2026-10-12 — TURN made a documented opt-in: `?relay=1` (TURN-only ICE), `/api/health` reports `turn`, `make turn-setup`/`turn-check`, relay E2E (+ relay-only-without-TURN never connects). README + web-era SETUP for the public repo.
- 2026-10-12 — 3–4 adaptive send level (ADR-0008, feat/adaptive-tier-cap): per pair 600 ⇄ 800 kbps from the 1 Hz stats sampler (up after 10 s headroom, down in ≤ 4 s), high = 800 kbps + maintain-resolution (an 800 cap alone left VP8 stuck at 270p). Unshaped 3-party VMAF 68.4 → 74.3/73.7 (steady state 75), send 1256 → 1590 kbps; 4-party 67.0 → 73.9, send +25 %, CPU/peer +10 pts. E2E squeeze (b=AS clamp) → base in 2.4–4.4 s. Exposed as `video.sendLevel` in QA stats/telemetry; lab reports `vmaf_late` + send-level summary.
- 2026-10-12 — Open-source prep: history rewritten (node_modules dropped, 46 MB → <1 MB; staging account subdomain and org bundle id scrubbed). All commit ids changed; doc references re-pointed to the new ids. Commits squashed away on feature branches are cited via the main commit that contains them.
