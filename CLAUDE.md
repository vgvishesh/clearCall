# Clearcall — high-fidelity voice/video calls in the browser

An installable web app (PWA) for iPhone, Android and desktop whose reason to exist is **better call quality than WhatsApp at equal or lower bandwidth**, with zero servers we operate.
V1 is **web-only** (ADR-0003). Native apps are parked in `docs/paused-native/`.

## V1 product (what "done" means)
1. Open app → **Start a call** → share link (WhatsApp etc.) → others tap the link → in the call. No accounts, no contacts.
2. Peer-to-peer media (full mesh). Up to **10 participants**; full video up to 4, adaptive thumbnails 5–10 (ADR-0005).
3. Clean speech (noise suppression) by default; **Music mode** for clean music.
4. Works on iPhone Safari / home-screen app, Android Chrome, desktop Chrome/Safari/Firefox — on any stable connection (STUN, TURN when configured).
5. Minimal bandwidth for the quality delivered; budgets are test gates.
6. Server side is one Cloudflare Worker (free tier): serves the app, relays encrypted signaling, mints TURN credentials. It never sees media, names, or room keys (ADR-0004).
7. Quality is tested automatically: Playwright multi-browser E2E + the media quality lab.

Design input: dark, calm, minimal; one accent color; big round controls; call UI usable one-handed on a phone. Architecture: `docs/ARCHITECTURE.md`, `docs/adr/`. Status: `docs/PLAN.md` — read at the start of non-trivial work, update when you finish.

## Repo map (pnpm workspace)
| Path | What |
|---|---|
| `protocol/` | **The contract.** TS types + runtime validators for client⇄server and peer⇄peer messages, fixtures. Package `@clearcall/protocol`. |
| `web/` | Vite + Preact + TypeScript PWA. `src/core/` = call engine (no UI imports), `src/ui/` = screens/components (no WebRTC calls), `src/core/types.ts` = the interface between them. |
| `signaling/` | Cloudflare Worker + `Room` Durable Object; serves `web/dist` as static assets. |
| `e2e/` | Playwright functional tests: multi-participant calls across Chromium/WebKit/Firefox, mobile viewports. |
| `quality/` | Media quality lab: network profiles, reference media, scorers, thresholds. |
| `scripts/` | Everything `make` calls. Hooks call these too. |

## Commands — always via `make`
```
make doctor          # toolchain check
make dev             # build web + run worker locally at http://localhost:8787 (serves app + signaling)
make verify          # fast gate for changed areas: format, lint, typecheck, unit tests
make web-test | signaling-test | protocol-check
make e2e             # Playwright multi-participant tests against the real worker (headless)
make screenshots     # Playwright screenshots of every screen at phone + desktop sizes → quality/reports/screens/
make quality PROFILE=4g_typical   # media quality lab run
```
Add missing targets to the Makefile/scripts rather than running ad-hoc commands repeatedly.

## Git & commit policy (hook-enforced where possible)
- `main` only ever receives **one squashed commit per finished feature**. Never commit on `main` directly (a hook blocks it; only the squash-merge commit is allowed).
- Work on `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `test/<slug>`, `docs/<slug>`, branched from an up-to-date `main`.
- **Commit early and often on the branch**: one logical step per commit (a module + its tests, a screen, a config change). Never batch a whole feature into one branch commit. Conventional messages: `feat(web): ...`, `fix(signaling): ...`, ending with the `Co-Authored-By` trailer.
- **Squash and merge when the feature is built and tests pass:** `make verify` green (plus `make e2e` if call behavior changed) on the branch, then
  ```
  git switch main && git merge --squash <branch> && git commit   # message: "<type>(<scope>): <feature summary>" + bullet list of what's in it + trailer
  git branch -D <branch>
  ```
  Then rebase any other open branches onto the new `main`.
- **Parallel work uses git worktrees** (Agent tool `isolation: "worktree"`): each agent works on its own package branch cut from the feature branch, commits there, and the orchestrator merges package branches into the feature branch (`git merge --no-ff`). Only the feature branch is squash-merged into `main`. Agents stay inside their assigned paths to keep merges clean.
- No remote yet. Pushing asks the owner.

## Autonomy & observability
The owner is out of the loop: you run, test, debug and improve everything yourself. Never guess at a call bug — reproduce it and read the evidence:
- `make diag N=<participants> DURATION=<s>` → full debug bundle (client logs of every peer, stats timeline, worker log, CPU, screenshots, anomaly summary).
- `make dev` then `.claude/state/logs/dev-server.log` → interleaved server + client telemetry (dev only).
- `window.__clearcall` (`?qa=1`): `logs()`, `stats()`, `statsTimeline()`, `transport()`, `inject(fault)`.
- Playwright traces/videos for failed E2E: `e2e/test-results/`; `pnpm --filter @clearcall/e2e exec playwright show-trace <zip>` is not viewable headless — read the attached console logs instead.
- Interactive look: Playwright MCP (headless, device emulation) or Claude in Chrome.
**Host limits (shared M1, 8 cores, ~23 GB free disk):** more than ~6 Chromium processes thermally throttles the machine (load avg 379, `kernel_task` 133 % observed) and produces fake failures (dead sockets, freezes). Large-call tests use one browser with N contexts; heavy runs never overlap. Docker pulls/builds need ≥ 15 GB free (hook-enforced); never prune the owner's Docker data.
Ping the owner only for: money/accounts (Cloudflare login, TURN/SFU credentials), real-device checks you can't automate, and product/design decisions.

## Rules of the road
- **Contract first.** Message shapes live only in `protocol/`; the UI↔engine interface only in `web/src/core/types.ts`. Change those first (`protocol-change` skill), then implementations.
- **Never weaken the oracle.** Don't edit `quality/thresholds.yaml`, `quality/reference-media/`, or skip/disable tests to get green. Explain to the owner instead. (Hook-enforced.)
- **Prove UI visually.** Screenshot at iPhone and desktop sizes and look at the images before calling UI work done (`ui-verify`).
- **Prove calls end-to-end.** Call-behavior changes need a passing Playwright test with ≥2 real browser peers exchanging media.
- **Media changes need numbers** (`quality-lab`): before/after on the same profiles.
- **Decisions get ADRs** (`adr` skill). Ping the owner only for product/design decisions or spending money; decide engineering details yourself and record them.
- Secrets never enter the repo or your context (`.dev.vars`, Cloudflare tokens).
- Keep the client small: no heavy deps without a one-line justification in the plan. Target < 100 KB gzipped JS for first load.

## Definition of done
`make verify` green (Stop hook enforces) · tests for new logic · UI screenshots reviewed · call changes covered by E2E · media changes have a quality comparison · `docs/PLAN.md` updated · squash-merged to `main` after tests pass.
