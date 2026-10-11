# quality/ — media quality lab
Load the `quality-lab` skill.

## Layout (built in milestone M2)
- `webpeer/` — minimal web client speaking our protocol; a "bot" participant.
- `runner/` — Python (uv): orchestrates a session (spawn bots via Playwright/Chrome with fake media from `reference-media/`, launch QA app builds, apply network profile), collects getStats + recordings, runs scorers, writes `reports/`, exits non-zero on threshold breach. `compare.py` diffs two reports.
- `netem/` — Docker setup applying `tc netem` per profile to bot traffic; `netem-gateway/` — doc + scripts for routing physical phones through a shaped Linux gateway.
- `profiles/*.yaml` — network conditions + topology + duration + media corpus.
- `reference-media/` — **owner-controlled** test corpus. Agents may read it, never write it (hook-enforced).
- `thresholds.yaml` — **owner-controlled** pass/fail gates (hook-enforced). Until adopted, see `thresholds.proposed.yaml`.
- `e2e/` — Maestro flows, shared by iOS and Android.

## Reference corpus (owner adds; record source + license for each file)
- Speech: VCTK / LibriSpeech (CC-BY); noisy speech: Microsoft DNS Challenge corpus (CC-BY).
- Music: CC0/CC-BY tracks covering voice+guitar, piano, full mix with drums.
- Video: Xiph.org derf collection (talking heads: akiyo, foreman…) as y4m; `runner/prepare_media.py` adds frame-ID overlays into `reports/cache/`, never into `reference-media/`.
- Large files via Git LFS.

## Metrics
| Metric | Tool | Notes |
|---|---|---|
| Video quality | VMAF (ffmpeg libvmaf), PSNR/SSIM | frames aligned by embedded frame-ID |
| Audio quality (full-ref) | ViSQOL v3 (speech + audio modes) | MOS-LQO 1–5 |
| Noise suppression | DNSMOS P.835 (SIG/BAK/OVRL) | no reference needed |
| Music fidelity | ViSQOL audio mode on music corpus | music mode must hold ≥ target |
| Latency | coded chirp (audio, mouth-to-ear), timestamp overlay (video, glass-to-glass) | |
| Smoothness | freezeCount, totalFreezesDuration/duration, framesDropped, concealment ratio | from getStats |
| Bandwidth | mean & p95 send+receive kbps per participant | **budget gate** |
| Connectivity | time-to-first-frame, ICE candidate type, setup success rate | |
