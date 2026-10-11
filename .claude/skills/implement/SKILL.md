---
name: implement
description: Build a feature end-to-end (protocol → worker → web core → UI → E2E) using Planner → Evaluator → Executor(s) → Validator, with feature branches, frequent commits and parallel worktree agents. Use for any user-facing feature or change spanning more than one area.
---
# implement — Planner → Evaluator → Executor(s) → Validator

## 0. Branch
From an up-to-date `main`: `git switch -c feat/<slug>`. Commit after every logical step (plan file, contract change, each module + its tests). Never commit on `main` (hook-enforced); `main` only gets the final squash commit.

## 1. Plan
Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PLAN.md`, relevant ADRs. Write `docs/plans/<slug>.md`:
- Goal + which V1 requirement it serves.
- **Contract changes first:** `protocol/` messages (with fixtures) and/or `web/src/core/types.ts` (CallController).
- **Work packages** that can run in parallel, each with: owner agent, *exact paths it may touch* (disjoint between packages), tasks, unit tests.
- **Acceptance criteria** a validator can run: make targets, Playwright spec names, screenshots, quality profiles + metrics.
- Risks (Safari/iOS quirks, permissions, autoplay, background, bandwidth).
Commit the plan.

## 2. Evaluate
Spawn `plan-evaluator` with the plan path. Fix blockers (max 2 rounds; then ask the owner). Commit.

## 3. Execute — parallel by default
1. Land contract changes yourself on the feature branch and commit (so every worker starts from the same contract).
2. Spawn one agent per work package **in a single message** with `isolation: "worktree"` and `run_in_background: true`. Each prompt includes: plan path, its package, allowed paths, base branch to start from (`git switch -c <pkg-branch> <feature-branch>` inside the worktree), "commit after each logical step", "finish with `make verify` green for your areas", "report branch name + commits + what's not done".
3. As each finishes: `git merge --no-ff <pkg-branch>` into the feature branch, run `make verify`, resolve conflicts (they should be rare if paths were disjoint). Delete merged package branches and worktrees.

## 4. Validate
Spawn `validator` with plan path + touched areas. It runs verify, `make e2e`, `make screenshots` (and reads the images), quality profiles for media changes, and returns PASS/FAIL per criterion. Failures → back to 3 (max 3 loops, then report to owner).

## 5. Close
Update `docs/PLAN.md` (status + Log), tick criteria in the plan, commit. Only when validation passed: `git switch main && git merge --squash feat/<slug> && git commit` (summary message + bullets + trailer), then `git branch -D feat/<slug>` and rebase other open branches onto `main`. Summarize to the owner: what shipped, evidence paths, what's left.
