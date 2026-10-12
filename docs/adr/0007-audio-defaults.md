# 0007 — Audio defaults: voice 32 kbps with DTX/FEC, RED off; music mode = stereo Opus 96 kbps

- Status: Accepted (W4, data-driven)
- Date: 2026-10-12

## Context
V1 requirements: clean speech (no background noise), clean music in Music mode, minimal bandwidth. W4 package A measured
the browser audio pipeline in the quality lab (unshaped, 2 peers, synthetic corpus; tables and report paths in the
`pkg/audio` commit messages, now on main).

## Decision
**Voice (default):** Opus 32 kbps mono, DTX on, in-band FEC on, RED off; browser NS + AGC + EC on.
**Music mode:** Opus 96 kbps with `stereo=1; sprop-stereo=1` negotiated (mono capture), DTX off, FEC on, RED off;
NS + AGC off, EC on (UI suggests headphones). 64 kbps is the economy option.

## Evidence
- Speech SIG drop (3.61 → 3.30) is entirely Chrome's noise suppressor; Opus and transport cost nothing (offline libopus
  SIG flat 3.57–3.66 from 16–64 kbps). NS buys +0.84 BAK and +0.25 OVRL, so it stays on. 40 kbps gives +0.05 PESQ
  (noise band) for +24 % bits, so voice stays at 32 kbps.
- Music: libwebrtc encodes mono Opus in VOIP (speech) mode and switches to AUDIO mode only when stereo is negotiated.
  Music SNR at 96 kbps: mono 5.1 dB → stereo 21.1 ± 1.4 dB (same bits); 64k stereo 18.5 dB; voice mode on music 0.6–1.0 dB.
- Loss (emulated Gilbert 5 %, no jitter): RED halves concealment (4.8 → 2.4 %) and +0.27 PESQ but costs 2.07× audio bits,
  multiplied by N−1 in a mesh → off by default. FEC showed no gain without jitter (pessimistic setup) but costs 0 kbps.
- Capture→playout latency 35–58 ms on localhost (excludes device mic/speaker buffers).

## Alternatives considered
- 40/48 kbps voice: within noise. NS off: worse overall. RED on always: bandwidth cost dominates in mesh.
- ML noise suppression (RNNoise/DeepFilterNet in an AudioWorklet) to recover SIG: promising, needs a dependency + CPU
  budget on phones — future ADR (W6).

## Consequences
Netem follow-up (ADR-0009, 2026-10-12): on shaped `3g_lossy` (5 % Gilbert loss, ±40 ms jitter, ~400 ms RTT) audio
concealment is 1.6–3.4 % with in-band FEC and no RED (gate 6 %), PESQ unchanged by the video changes. RED stays off;
an audio step-down to 16–20 kbps was not adopted (8–12 kbps of a ~150 kbps budget).
Revisit when (a) netem works on this host (FEC/RED under jitter; adaptive RED for ≤4 people at ≥3 % loss),
(b) ML NS is evaluated, (c) real owner media replaces the synthetic corpus. Lab caveat: identical audio files on both
peers make Chrome's echo canceller suppress music; music comparisons use `?ec=0` or per-peer corpora.
