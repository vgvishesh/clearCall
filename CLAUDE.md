# betterApp — high-fidelity voice/video calling (iOS + Android)

Native calling app whose whole reason to exist is **better call quality than WhatsApp at equal or lower bandwidth**.
Every change is judged by that. If you can't measure that a media change helps, it doesn't ship.

## Product requirements (non-negotiable)
1. Dead-simple UI: open app → see contacts → tap to call. Onboarding in under 30 seconds.
2. No backend servers we operate. Allowed: free-tier serverless (Cloudflare Workers + Durable Objects, Realtime SFU/TURN).
3. Group calls of **up to 10 participants**.
4. Speech is clean (no background noise) **and** music passes through cleanly (music mode).
5. Works for anyone on a stable connection, including behind CGNAT/symmetric NAT (TURN required).
6. Minimal bandwidth for the delivered quality — bandwidth budgets are hard test gates.
7. Fully native: Swift/SwiftUI (iOS), Kotlin/Jetpack Compose (Android).
8. Quality is tested automatically, locally and remotely.

Architecture and the reasoning behind each decision: `docs/ARCHITECTURE.md` and `docs/adr/`.
Current milestone and status: `docs/PLAN.md` — read it at the start of any non-trivial task, update it when you finish one.

## Repo map
| Path | What | Own CLAUDE.md |
|---|---|---|
| `ios/` | Swift/SwiftUI app, XcodeGen `project.yml` (the `.xcodeproj` is generated — never edit it) | yes |
| `android/` | Kotlin/Compose app, Gradle Kotlin DSL + version catalog | yes |
| `signaling/` | Cloudflare Worker + Durable Objects: signaling, presence, push relay, SFU/TURN credential minting | yes |
| `protocol/` | **The contract.** Signaling message JSON Schema + golden fixtures every client must round-trip | yes |
| `quality/` | Media quality lab: headless bot peers, network profiles, scorers, thresholds | yes |
| `docs/` | Architecture, ADRs, plan, per-feature plans | — |
| `scripts/` | Everything `make` calls. Hooks call these too. | — |

## Commands — always go through `make` (same commands for you, hooks, CI, humans)
```
make doctor            # toolchain + devices check. Run first when anything "doesn't work".
make verify            # fast gate for what changed: format-check, lint, compile, unit tests
make ios-build | ios-test | ios-run      # ios-run = build, install, launch on booted simulator
make android-build | android-test | android-run
make signaling-dev | signaling-test
make protocol-check    # both clients + worker round-trip protocol/fixtures
make e2e               # Maestro flows on iOS sim + Android emulator
make quality PROFILE=4g_typical         # local media-quality run against bots
make quality-all       # every profile in quality/profiles/
```
If a `make` target is missing for something you need, add it to the Makefile/scripts rather than running ad-hoc commands.

## Rules of the road
- **Parity.** A user-facing feature is not done until it exists on iOS *and* Android with the same behavior. Shared Maestro flows in `quality/e2e/` prove it.
- **The protocol is the contract.** Any signaling change starts in `protocol/` (schema + fixture), then worker, then both clients. Use the `protocol-change` skill.
- **Never weaken the oracle.** Do not edit `quality/thresholds.yaml`, `quality/reference-media/`, or disable/skip tests to make something pass. If a threshold is wrong, stop and tell the user why. (A hook enforces this.)
- **Prove UI changes visually.** Build, launch, screenshot both platforms (`ui-verify` skill) and look at the screenshots before saying a UI task is done.
- **Media changes need numbers.** Anything touching codecs, bitrate, audio processing, jitter buffers, or congestion control must include a before/after `make quality` comparison in the PR/plan.
- **Decisions get ADRs.** A choice that is expensive to reverse goes in `docs/adr/NNNN-title.md` (use the `adr` skill).
- **Secrets never enter the repo or your context.** APNs keys, keystores, Cloudflare tokens live in env/keychain. Don't `cat` them.
- **Test hooks are first-class.** Every media source (mic, camera) and sink must be injectable in the `qa` build so bots and tests can drive the app. Never hard-wire `AVCaptureDevice`/`Camera2` without going through the capture abstraction.
- Don't edit generated files: `*.xcodeproj/`, `build/`, `.gradle/`, `DerivedData/`.

## Definition of done (per task)
1. `make verify` green (the Stop hook runs it automatically for touched areas).
2. New logic has unit tests on each platform it touches.
3. UI: screenshots from both platforms reviewed. Media: quality report attached, no threshold regressions, bandwidth within budget.
4. `docs/PLAN.md` updated.
