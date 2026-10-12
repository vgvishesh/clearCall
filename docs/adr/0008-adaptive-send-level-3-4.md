# 0008 — Adaptive send level for 3–4 participant calls (600 ⇄ 800 kbps per pair)

- Status: Proposed (product direction decided by the owner 2026-10-12; engineering details here)
- Date: 2026-10-12
- Amends: ADR-0005 (3–4 tier row of the policy table)

## Context
ADR-0005 W4 measured the 3–4 tier cap knee: 600 kbps → VP8 settles at ~270p, VMAF 68; 800 kbps → 360p, VMAF 75
(+32 % upload). The owner decided to keep **both** settings and switch per user by the bandwidth available to them,
so good links get 360p and constrained links keep today's behaviour (CLAUDE.md: "minimal bandwidth for the quality
delivered").

Constraints: a mesh has one encode and one congestion controller (GCC) per pair, and the sender's uplink is shared
by N−1 streams. Firefox's H264 sender stalls on mid-stream `scaleResolutionDownBy` changes (codecs.ts). 2-party
(1500 kbps / 720p) and 5–10 (150 kbps / 180p) tiers stay as they are.

## Decision
**Two levels, bitrate + degradation preference only (no scale change):**

| level | maxBitrate | degradationPreference | encode (lab, VP8) |
|---|---|---|---|
| base | 600 kbps | browser default (balanced) | ~270p (encoder downscales itself) |
| high | 800 kbps | maintain-resolution | 360p |

High applies only at 3–4 participants when the receiver's tile wants the full 360p rung; the start bitrate stays at
600. `maintain-resolution` is part of high because an 800 cap alone does **not** bring a sender back from 270p:
libwebrtc's quality scaler keeps the 270p restriction it took at 600 kbps (lab, below). Changing the preference
clears it. Leaving high restores `balanced`. Engines that reject the preference get the bitrate change alone
(retried without it, remembered per pair).

**Decision per pair, coordinated per sender** (`web/src/core/adaptive.ts`, driven by the 1 Hz stats sampler in
`MeshTransport`):
- Inputs per pair: candidate-pair `availableOutgoingBitrate`, outbound video `qualityLimitationReason`,
  remote-inbound `fractionLost`, our audio bitrate.
- Up: 10 s of continuous headroom: estimate ≥ 1.1 × (800 kbps + audio), loss < 2 %, no CPU limitation in the last
  30 s. Probe: if the estimate is clean and ≥ 1.15 × what base sends for 15 s but under the headroom bar (GCC in
  application-limited mode does not grow its estimate beyond what is sent), try high anyway.
- Down (fast): 3 s of continuous trouble while high: estimate < 800 kbps + audio; loss ≥ 5 %; CPU limitation; or
  `bandwidth` limitation with the estimate under the upgrade bar. The limitation alone is not trusted, because it
  reflects the encoder's sticky quality-scaler state. Bandwidth signals are ignored for 6 s after an upgrade.
- Anti-flap: every downgrade waits 20 s before the next upgrade, doubling to 160 s on repeated failures. A high
  period of 120 s resets the wait.
- Per sender: CPU is shared, so `cpu` on any pair holds or drops every pair. Upgrades are staggered one pair per 5 s,
  so a shared uplink that cannot carry (N−1) × 800 kbps is detected after one extra stream.
- Why per pair rather than one level per sender: each pair's GCC already sees the shared uplink (flows on one
  bottleneck converge to a fair share), and per-pair decisions also handle a receiver with a poor downlink without
  lowering everyone else. "Per user" from the owner's decision maps to "per sender's links".
- Observability: `video.sendLevel`, `video.sendMaxBitrate` and `video.remoteFractionLost` in
  `__clearcall.stats()` / `statsTimeline()` and the dev telemetry log. A `send level` log line records each change
  with its reason and estimate. `?vlevel=base|high` pins the level for lab A/B runs.

## Alternatives considered
- **One level per sender (min or sum of pair estimates):** a single receiver with a bad downlink would lower every
  stream. Summed estimates overstate a shared uplink in application-limited mode, so they don't buy safety over
  staggering plus fast downgrade.
- **Resolution switch via `scaleResolutionDownBy` (360 ⇄ 270):** works on Chromium/WebKit, but adds a scale-change
  path that Firefox's H264 sender does not survive, and the encoder already picks 270p by itself at 600.
- **800 cap only (no degradation preference):** measured: the sender stays at 270p with
  `qualityLimitationReason=bandwidth` after the upgrade, so the gain mostly disappears and the controller flaps.
- **Always 800:** +32 % upload for everyone, including links that can't carry it (owner chose adaptive).

## Consequences
- Good links: 360p for 3–4 participant calls at +~400 kbps upload per sender (3-party). Constrained links: today's
  600 kbps behaviour after ≤ ~4 s.
- Browsers without `availableOutgoingBitrate` (Firefox) never go high, which is conservative: they keep today's
  behaviour.
- Signals that would show this is wrong: `send_level_changes_max` > 2 per minute in lab or diag (flapping);
  freezes or `qualityLimitationReason=cpu` rising at 3–4 participants on phones; netem `bw_squeeze` showing high
  held while the link is under 2 × 832 kbps.
- Cost to reverse: delete the `SenderLevels` call in `MeshTransport.adaptLevels` (level stays base) — one line.

## Evidence (2026-10-12, branch feat/adaptive-tier-cap)
Lab: headless Chromium, M1 host shared with other agents, **unshaped** (`good_wifi`, no netem), synthetic
`talking_head` corpus (pessimistic absolute VMAF), viewport 390×844@3 so receivers want the 360p rung, 60 s,
seed 1. VMAF is the p0→p1 direction. `vmaf_late` = second half of the aligned frames (steady state). Send kbps is
the max over participants. Reports in `quality/reports/` (raw recordings deleted after scoring).

**Before / after (same profile, same settings):**

| n | build | VMAF | VMAF p5 | VMAF late | send kbps | recv height | CPU/peer | high (2nd half) | first high | level changes/pair |
|---|---|---|---|---|---|---|---|---|---|---|
| 3 | main 1099af7 (base3) | 68.42 | 63.44 | 68.1¹ | 1256 | 270 | 51 % | — | — | — |
| 3 | adaptive, 800 cap only (cand3) | 67.61 | 63.62 | — | 1477 | 270 | 45 % | — | ~12 s | flapping (20–40 s backoff) |
| 3 | adaptive, final (cand3b) | 74.29 | 68.13 | 75.04 | 1593 | 344² | 49 % | 100 % | 10.3 s | 1 |
| 3 | adaptive, final (cand3c) | 73.66 | 66.74 | 75.05 | 1586 | 341² | 48 % | 100 % | 11.5 s | 1 |
| 3 | adaptive, branch head a91f8a5 (final3) | 73.93 | 66.69 | 75.53 | 1589 | 345² | 58 % | 100 % | 10.4 s | 1 |
| 4 | pinned base (`?vlevel=base` = main policy) | 66.97 | 63.07 | 66.80 | 1887 | 270 | 55 % | 0 % | — | 0 |
| 4 | adaptive, final (cand4) | 73.87 | 67.00 | 75.07 | 2367 | 336² | 65 % | 100 % | 10.1 s | 1 |

¹ Rescored with the same scorer after the run (standalone `score.ts`, ~1 VMAF above in-lab scoring for both base and
candidate: base 69.8 / late 68.1, cand3b 75.2 / late 76.5).
² Mean over the run, including the ~10–15 s at 270p before the upgrade. After the upgrade every pair sends 360p with
`qualityLimitationReason=none`.

Compare (`pnpm compare`, base3 → cand3b): **trade-off**, as decided by the owner: VMAF +5.9 (p5 +4.7, steady state
+7 to +8), send +27 % (1256 → 1593 kbps), freezes 0 → 0, audio unchanged. At 4 participants: VMAF +6.9 (steady
state +8.3), send +25 %, CPU per peer +10 points (three 360p encodes instead of three 270p ones). The controller
drops to base on `qualityLimitationReason=cpu`.

**The 800 cap alone is not enough (cand3):** after the upgrade the second pair stayed at 270p with
`qualityLimitationReason=bandwidth` and a 1.45 Mbps estimate. The controller read that as congestion and flapped
under backoff. With `maintain-resolution` (cand3b/c), each pair is back at 360p within ~3 s of its upgrade, and the
limitation reads `none`.

**Upgrade happens on a good link (chicken-and-egg):** at the 600 cap Chromium's estimate stays at 1.19–1.53 Mbps
(set by the start-up probes, then frozen in application-limited mode), above the 915 kbps headroom bar. The upgrade
fires after the 10 s hold and the second pair follows 5 s later. The probe path covers estimates held near base
usage (after a congestion episode). It is unit-tested, not yet exercised in the lab.

**Squeeze (fast downgrade), E2E Chromium 3-party:** no netem on this host for this run. The netem peer containers
loaded the app as an insecure origin and showed "unsupported"; the netem branch is being fixed separately. Squeeze
method: Alice applies remote descriptions with `b=AS:400` on video and renegotiates (ICE restart). libwebrtc clamps
GCC's estimate to the SDP max (`availableOutgoingBitrate` 1181k → 400k within 1 s). Result: every pair back at base
(600 kbps cap) in 4.3 / 4.4 / 2.4 s, reason `estimate-drop`. The first version took 7.8–9.1 s because the 6 s
post-upgrade grace hid a drop that came 1 s after an upgrade. Fixed: during grace, an estimate below base need counts.
Limitation: this squeeze has no queueing delay or loss. `bw_squeeze` / `3g_lossy` under netem at 3 participants
still need to run (loss path, real queueing).

**Unit tests:** `adaptive.test.ts`: upgrade after the hold; hold restarts on a bad sample; fast downgrade on estimate
drop, edge-of-estimate limitation, loss and CPU; grace; CPU cooldown; no estimate (Firefox) → base; probe;
no flapping on a noisy estimate or a single bad sample; exponential backoff 20 → 160 s; stable-period reset;
ineligible; sender coordination (stagger, shared CPU, per-pair poor receiver, reset).
`policy.test.ts`: levels and degradation-preference merge/restore/fallback. `mesh.test.ts`: sampler-driven upgrade
and squeeze, QA polls don't drive it, an engine that rejects the preference still gets 800 kbps, 2-party has no level.
