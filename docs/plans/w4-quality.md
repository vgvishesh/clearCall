# Plan: W4 — call quality from data

Feature branch `feat/w4-quality`; package branches merge back with --no-ff; squash to main when acceptance passes.
Every media change follows the quality-lab workflow: baseline → change → same profiles (same seed) → `pnpm compare` → table in the commit message. Lab/diag runs are serialized host-wide by the lab lock; don't bypass it.

## Baseline (main fab5f89, good_wifi, unshaped, 2 peers, synthetic corpus)
VMAF 81.5 (p5 76.0) · send 1520 kbps (policy cap 1.5 Mbps) · TTFF 848 ms · freezes 0.5 % · DNSMOS noisy-in S/B/O 3.61/2.48/2.42 → received 3.27/3.68/2.86 · PESQ-WB vs sent 1.60 (metric misuse on noisy corpus) · ramp 180p→720p ≈ 16 s (fake device) · diag N=4: low-bitrate soft anomalies (encoder under-using 600 kbps tier).

## Package V — video (media-engineer, branch pkg/video, DEV_PORT 8796)
Paths: `web/src/core/{policy,codecs,peer-session}.ts`, video parts of `web/src/core/sdp.ts`, `quality/**` (not thresholds/reference-media), tests.
1. Explain VMAF 81.5 at 1.5 Mbps / 360p source: split pipeline loss (MediaRecorder, alignment, scaling) from encode loss — e.g. selftest at 4–8 Mbps, compare decoded frame size vs source, check `qualityLimitationReason`/`encoderImplementation`. Fix the lab if it's the lab.
2. Ramp-up: time-to-target-resolution from join. Try higher start bitrate (`x-google-start-bitrate` on video fmtp in our SDP munging and/or initial encoding params). Report time-to-target and overshoot.
3. Codec bake-off per tier (2, 4, 10 participants; one Chromium, N contexts — never > 6 browser processes): VP8 vs VP9 vs H264 (AV1 if available) — VMAF, kbps, encodeMs/frame, CPU. Recommend codec order per tier (CPU matters most in 5–10 mesh).
4. Policy table: retune ADR-0005 caps with data (VMAF knee vs bitrate). Update ADR-0005 with the evidence.
Acceptance: compare tables in commits; good_wifi VMAF ≥ 85 at ≤ current bitrate OR a documented reason; 2-party time-to-target ≤ 5 s; codec recommendation per tier with numbers.

## Package A — audio (media-engineer, branch pkg/audio, DEV_PORT 8797)
Paths: `web/src/core/media.ts`, audio parts of `web/src/core/sdp.ts`, `quality/**` (only new files or audio scorers/profiles), tests.
1. Speech: DNSMOS SIG drops 3.61 → 3.27 through the call. Separate causes (Opus 32 vs 40/48 kbps; browser NS/AGC; DTX) on `speech_clean` and `speech_noisy`. Keep BAK gains; recover SIG. PESQ-WB on `speech_clean` = transport fidelity.
2. Music mode: voice vs music on `music_mode`; music SNR/LSD must clearly beat voice; find the bitrate knee (64/96/128).
3. Loss resilience: `--netem` (Docker; disk guard ≥ 15 GB free — never prune owner data). `3g_lossy`: FEC, RED (`?red=1`), DTX; decide RED default with data.
4. Mouth-to-ear latency probe (coded chirp) if time permits.
Acceptance: compare tables; recommendation per item with numbers; music mode measurably better than voice on music.

## Orchestrator
Revise `quality/thresholds.proposed.yaml` from the data (PESQ gate only on clean corpus; kbps gate consistent with policy; per-tier gates) and send to the owner for adoption.
