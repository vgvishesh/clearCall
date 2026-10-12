# quality/ — media quality lab
Load the `quality-lab` skill.

## Layout
- `src/` (TypeScript, package `@clearcall/quality`): `lab.ts` orchestrates a session — launches Chromium peers on the real app (`make dev`) with `--use-file-for-fake-*-capture` reference media, applies the network profile, records received media (MediaRecorder via the QA hook) and getStats, runs scorers, writes `reports/`, exits non-zero on threshold breach. `compare.ts` diffs two reports.
- `scorers/` — ffmpeg/libvmaf for video; Python via `uv run` for PESQ and DNSMOS.
- `netem/` — Docker (Linux) setup: peers run in containers whose interfaces are shaped by `tc netem` per profile (macOS can't shape browser UDP reliably).
- `profiles/*.yaml` — network conditions + topology + duration + media corpus.
- `reference-media/` — **owner-controlled** test corpus. Agents may read it, never write it (hook-enforced).
- `thresholds.yaml` — **owner-controlled** pass/fail gates (hook-enforced). v2 adopted by the owner 2026-10-12.

## Tools (run from quality/, or `pnpm --filter @clearcall/quality exec …`)
| Command | What |
|---|---|
| `tsx src/prepare-media.ts [--force]` | synthetic corpus → `.cache/media/` (say speech, noisy speech, music, two y4m loops with a frame-ID barcode; every frame verified) |
| `pnpm lab --profile <name\|all> [--netem] [--duration s]` | full lab run (`make quality PROFILE=…`); UNSHAPED without `--netem`; exit 1 on breach |
| `pnpm lab --selftest [--kbps 1000]` | no app needed: in-page WebRTC loopback with file-fed media → real scorers |
| `pnpm compare <base> <cand>` | report diff + win/loss verdict |
| `tsx src/score.ts --video-ref talking_head --video-deg rec.webm` (also `--speech-*`, `--music-*`, `--dnsmos-only`) | score any file pair |
| `tsx src/validate-scorers.ts` | scorer sanity: reference vs ffmpeg-degraded copies, checks expected orderings |
| `tsx src/netem-check.ts --profile 3g_lossy` | verify tc netem shaping on Docker (alpine peers, ping RTT/loss) |
| `make diag N=4 DURATION=60 ARGS="--fault drop-signaling@20s"` | debug bundle → `reports/diag-<ts>/summary.md` |
Python scorers (`scorers/*.py`) run via `uv run --script` (PEP 723 deps); the DNSMOS model downloads to `.cache/models/`.
Docker Desktop's VM lacks `ifb`, so `--netem` shapes uplink only (reported). The netem image `clearcall-lab-peer:1.64.0` (ubuntu:24.04 + Node + Playwright 1.64 headless shell, one layer; built on first `--netem` run) needs ~1 GB inside the Docker VM; run `make quality PROFILE=<p> ARGS=--netem`. Peers load the app at `http://localhost:<port>` via an in-container TCP forwarder (secure context; chrome-headless-shell ignores the insecure-origin flag), run-server needs `--unsafe` to accept launch args, and TCP sport 3000 (Playwright control, recordings) bypasses the shaped band.

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
