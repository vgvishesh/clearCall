---
name: quality-lab
description: Run, interpret and extend automated audio/video call-quality tests (bots, network profiles, VMAF/ViSQOL/DNSMOS/latency/getStats, bandwidth budgets). Use for any media change, quality regression, or question about call quality numbers.
---
# quality-lab
Read `quality/CLAUDE.md` first for layout and metric definitions.

## Run
- One profile: `make quality PROFILE=4g_typical`; all: `make quality-all`. Reports: `quality/reports/<ts>-<profile>/report.{md,json}` + recorded media.
- Topologies via profile: `bot↔bot` (lab self-test), `app↔bot` (needs `make ios-run`/`android-run` with the QA build), `app + 9 bots` (group).
- Remote: `make signaling-deploy-staging` then the `quality-remote` GitHub workflow (owner-triggered).

## Media change workflow (mandatory)
1. Baseline: run the relevant profiles on the unchanged code, keep the report path.
2. Make the change. 3. Re-run the same profiles with the same seed.
4. Compare: `uv run runner/compare.py <baseline> <candidate>` → table of deltas. Win = better quality at ≤ bandwidth, or equal quality at less bandwidth. Note variance: re-run 3× if a delta is within noise (VMAF ±1, MOS ±0.05).
5. Put the comparison table in the plan/PR. Never edit `thresholds.yaml`; if you believe a threshold is wrong, say why with data.

## Interpreting failures
- Low VMAF + `qualityLimitationReason=bandwidth` → congestion control / bitrate allocation. `=cpu` → encoder too heavy for device; lower resolution or switch to HW codec.
- Freezes with low loss → jitter buffer / keyframe requests (check `pliCount`, `firCount`). Freezes with high loss → FEC/RTX/NACK settings.
- Audio MOS drops with `concealedSamples` high → loss; enable RED/FEC. DNSMOS SIG low but BAK high → noise suppressor eating speech; music-mode corpus failing → NS/AGC active in music mode.
- Latency high with good network → playout delay / jitter buffer target too large.
