# Plan & status

Agents: read this at the start of non-trivial work; update the status column and "Log" when you finish something.
Per-feature plans live in `docs/plans/<feature>.md` (written by the `implement` skill).

## Milestones
| # | Milestone | Exit criteria | Status |
|---|---|---|---|
| M0 | Harness | hooks, skills, agents, make targets, doctor green | in progress (toolchain blocked: see docs/SETUP.md) |
| M1 | Skeletons | `ios/` XcodeGen app + `android/` Compose app build, launch, screenshot via `make ios-run`/`android-run`; `signaling/` Worker with `wrangler dev` + tests; `protocol/` schema v0 + fixtures round-tripped by all three | todo |
| M2 | Quality lab v0 | `quality/webpeer` bot + Playwright runner; netem profiles; VMAF/ViSQOL/DNSMOS/getStats scorers; `make quality PROFILE=...` produces a report for bot↔bot | todo |
| M3 | 1:1 P2P call | onboarding (identity keypair + invite link), contacts, call/ring via CallKit/Telecom + VoIP/FCM push, STUN+TURN; app↔bot quality report passes `4g_typical` | todo |
| M4 | Audio excellence | voice mode (ML NS) + music mode; DNSMOS/ViSQOL targets met on noisy + music corpora | todo |
| M5 | Group calls | mesh ≤3, Cloudflare SFU 4–10 with simulcast + layer selection; 1 device + 9 bots passes gates | todo |
| M6 | E2EE on SFU path, codec tuning (AV1/VP9/H.264 bake-off) | report shows bandwidth-at-equal-VMAF vs baseline | todo |
| M7 | Remote quality + release | staging Worker, GH Actions remote runs, TestFlight / Play internal track | todo |

## Open decisions (owner)
- Identity/discovery: invite link (recommended v1) vs phone OTP vs Sign in with Apple/Google — ARCHITECTURE §6
- Min OS: iOS 17 / Android 8 (API 26) proposed
- App name / bundle id (placeholder `com.example.clearcall`)

## Log
- 2026-10-11 — M0 harness scaffolded.
