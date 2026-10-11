---
name: quality-lab
description: Run, interpret and extend automated audio/video call-quality tests for Clearcall (Chromium peers with reference media, netem network profiles, VMAF/PESQ/DNSMOS/getStats, bandwidth budgets). Use for any media change, quality regression, or question about call quality numbers.
---
# quality-lab
Read `quality/CLAUDE.md` for layout and metrics.

## Run
`make quality PROFILE=4g_typical` · `make quality-all`. Reports in `quality/reports/<ts>-<profile>/` (report.md, report.json, recorded media).
Network shaping uses Docker + `tc netem` (Linux), because browsers can't throttle WebRTC UDP. If Docker isn't running: `open -a Docker`, wait, retry. Without Docker only the `good_wifi`-style unshaped profile is meaningful — say so in the report.

## Media change workflow (mandatory)
1. Baseline on `main` for the relevant profiles (keep report paths).
2. Change → same profiles, same seed. 3. `pnpm --filter @clearcall/quality compare <base> <cand>`.
4. Win = better quality at ≤ bandwidth, or equal quality at less bandwidth. Repeat 3× when deltas are within noise (VMAF ±1, MOS ±0.05).
5. Put the table in the plan/commit message. Never edit `thresholds.yaml` — argue with data to the owner.

## Reading failures
- Low VMAF + `qualityLimitationReason=bandwidth` → bitrate policy/congestion; `=cpu` → encode too heavy (mesh!) → lower per-peer resolution/fps.
- Freezes at low loss → keyframe/PLI handling; at high loss → NACK/FEC/RED.
- Audio MOS low + high `concealedSamples` → loss → RED/FEC. DNSMOS SIG low but BAK high → noise suppressor eating speech. Music corpus failing → NS/AGC still active in music mode.
