# 0009 — Bitrate floor and ceiling under Chrome's congestion controller (lossy and jittery links)

- Status: Proposed (engineering decision; the owner decides the freeze/latency trade-off below)
- Date: 2026-10-12
- Amends: ADR-0005 (policy table gets a floor and a ceiling column); ADR-0007 follow-up (RED/FEC evaluated, not adopted)

## Context
The first shaped (netem) lab runs (main 1cde796) breached every gate on lossy links. Worst: `3g_lossy` (uplink
400 kbps, one-way delay 150 ms ± 40 ms jitter, 5 % Gilbert loss) gave VMAF 38–42, freeze 19–26 %, and the 3-party run
VMAF 28 with 0.35 of frames delivered. libwebrtc's send-side congestion controller (GCC) is the only rate control we
have in the browser. We can't change it or set field trials. The levers are the SDP bitrate parameters, `setParameters`,
codec choice, `jitterBufferTarget`, and `scalabilityMode`.

## Evidence (2026-10-12, branch feat/lossy-link-resilience)
Lab: netem on Docker Desktop (4 vCPU VM), uplink shaping only, headless Chromium 156, synthetic corpus. The host is
shared with the owner's desktop apps (load 5–17 during these runs), so single runs are noisy. Key claims rest on
repeated or same-session runs. Root-cause runs use the lab's `--link` diagnostic override and URL lab flags. They are
not gate runs.

**Root cause 1: GCC's estimate collapses to ~85 kbps.** It isn't the start bitrate. With `?vstart=300`, the estimate
still decays to 85–130 kbps. It isn't missing FEC either (see below).
- Same profile without jitter (`--link jitter_ms=0`): estimate 130–285 kbps, video 96–121 kbps, VMAF 57 (vs 39–42).
- So netem's in-order jitter is read as congestion by the delay-based estimator, and random loss does the rest.
  netem with a `rate` keeps packets in order, so jitter becomes a sawtooth of queueing delay. The measured RTT is
  ~395 ms against the 300 ms the profile intends. A cellular link with scheduler jitter looks much the same, so the
  profile is not wrong.
- Once collapsed, the estimate settles near 85 kbps and climbs back at about 8 %/s (bw_squeeze after the squeeze
  lifts: 113 → 1600 kbps in ~30 s, 3-party: 84 → 740–940 kbps in 30 s).

**Root cause 2: freezes are NACK round trips.** At ~400 ms RTT every lost packet of a referenced frame stalls
playback for at least one RTT. Chrome's adaptive jitter buffer sits at 250–550 ms.
- PLIs received: 0 and keyframes: 0–1 in every run, so every frame was eventually repaired by retransmission.
  RTX bytes ≈ the loss rate (4–6 %).
- A larger buffer removes freezes in proportion, at the cost of latency (floor runs, freeze ratio):
  adaptive 0.14–0.27 · `jitterBufferTarget` 600 ms 0.11–0.14 · 1000 ms 0.075.
- Temporal layers (AV1 L1T3) did not help: 0.27, VMAF −2.
- FEC: Chrome offers ULPFEC only for VP8/VP9; AV1 and H264 get none, and FlexFEC is behind a field trial.
  - VP8 forced: VMAF 29, 12 fps.
  - VP9 + floor: FEC overhead 25–35 % (video sent 125–130 vs encoder target 82–103 kbps), VMAF 40, freeze 0.20
    (no gain).

**Root cause 3: the probe overshoot and the "4g send over cap".** GCC probes with RTX padding up to its estimate:
2.5–3 Mbps on the 3 Mbps 4g uplink.
- Single seconds reached 2.4–2.8 Mbps against a 1.5 Mbps cap.
- The receiver's RTX share was 10–12 % of the bytes it received. The sender's real retransmissions were ~1 %
  (11 kbps).
- Probe bursts on the jittery 3 Mbps uplink were followed by estimate drops (2655 → 1145 kbps) and freezes
  (baseline 4g at t ≈ 40 s).

**Lab artefacts found on the way (fixed in quality/src):**
- The timeline summary had no end bound. The ~25 s after the window, when the lab pulls recordings out of the pages
  over CDP, counted toward freezes.
  - 4g baseline 095003: 2.2 of 3.0 s and 2.7 of 3.7 s of the freeze total fell after the window.
  - high_rtt_intl: 2.1 of 4.9 s and 1.9 of 3.6 s.
  - That was most of problem 2.
- TTFF was timed from the host's click, so it included the guest's page load over the shaped link. `join_ttff_ms`
  now times each joiner from its own Join click.

## Decision
1. **Floor (2-party): `x-google-min-bitrate=200`** (kbps), on every video codec and on Opus. The Opus copy is needed
   because the audio channel pushes its own SDP bitrate config to the shared transport controller, last writer wins.
   With the floor on video only, the answerer lost it in the lab: one side at 200 kbps, the other at 84–137.
2. **Floor guard** (`floor-guard.ts`). Below the floor GCC can no longer back off for real congestion, so the app does
   it, using the signal random loss can't fake: a standing queue.
   - Trouble = RTT more than 300 ms above its 30 s minimum, or receiver loss ≥ 20 %, for 3 s, while the estimate sits
     at the floor.
   - On trouble, cap the encoder at 0.6 × what it sends, minimum 50 kbps. Without trouble, raise the cap ×1.15 every
     4 s.
   - This uses `setParameters` only, with no renegotiation.
3. **No floor at 3–4 or 5–10.** Pairs share one uplink. At 3 parties a 150 kbps floor per pair raised loss from 5 to
   10 % and freezes from 0.19 to 0.41 on 3g_lossy.
4. **Ceiling: `x-google-max-bitrate` = top tier cap × 1.2 + voice audio** (2-party 1832, 3–4 992, 5–10 212 kbps), on
   video and Opus. This bounds GCC probing to just above what the encoder may use. The 3–4 value stays above
   ADR-0008's 915 kbps upgrade bar.
5. **Not adopted (data above):**
   - Video FEC (VP8/VP9 ULPFEC).
   - Codec switch on loss.
   - Lower start bitrate.
   - L1T3.
   - Audio RED: concealment is already 1.6–3.4 % on 3g_lossy against a 6 % gate, and RED doubles audio bits per
     pair.
   - Audio step-down to 16–20 kbps: it frees 8–12 kbps of a 150 kbps budget, which is noise next to the floor.
6. **Owner decision needed:** a larger jitter buffer on high-RTT lossy links (`jitterBufferTarget` ≈ RTT + 200 ms)
   trades about +250–600 ms of mouth-to-ear latency for roughly halving freezes. It is not enabled (lab flag `?jbt=`).

## Alternatives considered
- **Floor on all tiers:** the 3-party data above shows self-congestion.
- **Adaptive floor via renegotiation:** the SDP floor can only change through an offer/answer. The guard gets the same
  effect with `setParameters`.
- **No ceiling, keeping GCC's large headroom:** see Consequences. Headroom absorbs estimate dips, but the probes
  themselves caused dips and the send overage.

## Consequences
- 3g_lossy 2-party video goes from ~45 to ~125 kbps, VMAF 39–42 → 55–57, delivery 0.66 → 0.89–0.92. Freezes stay at
  0.14–0.27 (NACK round trips; see decision 6).
- On a link slower than the floor (diagnostic: 3g_lossy with a 150 kbps uplink), floor + guard was no worse than stock
  GCC:
  | config | freeze | concealment | RTT | loss |
  |---|---|---|---|---|
  | floor + guard | 0.60 | 0.081 | 921 ms | 12 % |
  | no floor | 0.72 | 0.117 | 1046 ms | 17 % |

  The guard ran AIMD between 50 and 87 kbps.
- Signals this is wrong:
  - `floor guard` log lines on good links (it should only fire at the floor).
  - Rising concealment or RTT on real 2-party calls over very slow uplinks.
  - A 2-party send rate stuck at 200 kbps while `rttMs` climbs.
- Cost to reverse: `videoFloorKbps` / `videoCeilingKbps` return null. One line each, and `?vmin=0&vmax=0` reproduces
  the old behaviour for A/B.
