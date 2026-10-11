# quality/ — media quality lab
Load the `quality-lab` skill.

## Layout
- `src/` (TypeScript, package `@clearcall/quality`): `lab.ts` orchestrates a session — launches Chromium peers on the real app (`make dev`) with `--use-file-for-fake-*-capture` reference media, applies the network profile, records received media (MediaRecorder via the QA hook) and getStats, runs scorers, writes `reports/`, exits non-zero on threshold breach. `compare.ts` diffs two reports.
- `scorers/` — ffmpeg/libvmaf for video; Python via `uv run` for PESQ and DNSMOS.
- `netem/` — Docker (Linux) setup: peers run in containers whose interfaces are shaped by `tc netem` per profile (macOS can't shape browser UDP reliably).
- `profiles/*.yaml` — network conditions + topology + duration + media corpus.
- `reference-media/` — **owner-controlled** test corpus. Agents may read it, never write it (hook-enforced).
- `thresholds.yaml` — **owner-controlled** pass/fail gates (hook-enforced). Until adopted, see `thresholds.proposed.yaml`.

## Reference corpus (owner adds; record source + license for each file)
- Speech: VCTK / LibriSpeech (CC-BY); noisy speech: Microsoft DNS Challenge corpus (CC-BY).
- Music: CC0/CC-BY tracks covering voice+guitar, piano, full mix with drums.
- Video: Xiph.org derf collection (talking heads: akiyo, foreman…) as y4m; `src/prepare-media.ts` adds frame-ID overlays into `reports/cache/`, never into `reference-media/`.
- Large files via Git LFS.

## Metrics
| Metric | Tool | Notes |
|---|---|---|
| Video quality | VMAF (ffmpeg libvmaf), PSNR/SSIM | frames aligned by embedded frame-ID |
| Audio quality (full-ref) | PESQ wideband (speech), ViSQOL later if needed | MOS-LQO 1–4.5 |
| Noise suppression | DNSMOS P.835 (SIG/BAK/OVRL) | no reference needed |
| Music fidelity | spectral/SNR-based score on music corpus (ViSQOL audio mode later) | music mode must beat voice mode |
| Latency | coded chirp (audio, mouth-to-ear), timestamp overlay (video, glass-to-glass) | |
| Smoothness | freezeCount, totalFreezesDuration/duration, framesDropped, concealment ratio | from getStats |
| Bandwidth | mean & p95 send+receive kbps per participant | **budget gate** |
| Connectivity | time-to-first-frame, ICE candidate type, setup success rate | |
