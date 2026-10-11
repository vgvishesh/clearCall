---
name: implement
description: Build a feature end-to-end across iOS, Android, signaling and protocol using Planner → Evaluator → Executor → Validator. Use for any user-facing feature or any change spanning more than one area of the repo.
---
# implement — Planner → Evaluator → Executor → Validator

Input: a feature request. Output: the feature working on both platforms, verified, with `docs/PLAN.md` updated.

## 1. Plan (you, or the Plan agent for large features)
Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PLAN.md`, relevant ADRs. Write `docs/plans/<slug>.md`:
- **Goal** and which CLAUDE.md requirement(s) it serves.
- **Contract first:** protocol messages added/changed (with fixture names), Worker endpoints/DO changes.
- **Per-platform tasks:** iOS, Android, signaling, quality — each with files to touch and unit tests to add.
- **Acceptance criteria** written as checks a validator can run: `make` targets, Maestro flow names, screenshots to capture, quality profiles + metrics that must hold.
- **Risks** (audio session, background/CallKit/Telecom, permissions, battery, bandwidth).
For a decision that is expensive to reverse, also write an ADR (`adr` skill).

## 2. Evaluate (spawn `plan-evaluator` agent)
Pass it the plan path. It returns BLOCKERS / CONCERNS. Fix every blocker in the plan; address or explicitly accept concerns. Max 2 rounds; if blockers remain, stop and ask the owner.

## 3. Execute
Order: `protocol/` → `signaling/` → clients. Once the contract is in, spawn `ios-engineer` and `android-engineer` **in parallel** (one message, two Agent calls), each given: plan path, its task list, acceptance criteria. Media/codec/audio work goes to `media-engineer`. Worker work to `signaling-engineer`.
Each executor must finish with its own area's `make verify` green and report: files changed, tests added, anything it could not do.

## 4. Validate (spawn `validator` agent)
It runs, in order, and reports pass/fail with evidence:
1. `make verify AREAS="<touched areas>"` and `make protocol-check` if the contract changed
2. `make ios-run` + `make android-run`, deep link to the feature, `make screenshots NAME=<slug>`, then reads both PNGs and compares them with each other and the acceptance criteria (parity, layout, dark mode, truncation)
3. `make e2e FLOW=quality/e2e/<slug>.yaml` when a flow exists (write one for every user-facing flow)
4. `make quality PROFILE=...` for any media-affecting change, compared to the last report on `main`
Anything failing → back to step 3 with the validator's findings. Loop at most 3 times, then report to the owner.

## 5. Close
Update `docs/PLAN.md` (status + Log line), tick acceptance criteria in the plan file, summarize to the owner: what shipped, evidence (screenshot paths, report paths), what's left.
