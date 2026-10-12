# 0005 — Full mesh up to 10 with a participant-count bandwidth policy

- Status: Accepted (V1); 3–4 tier cap amended by ADR-0008
- Date: 2026-10-11

## Context
V1 is pure P2P (no SFU). In a mesh each participant encodes and uploads one stream per peer.

## Decision
Full mesh, hard cap 10. Per-connection encode caps by participant count (2: 720p/1.5 Mbps; 3–4: 360p/600 kbps; 5–10: 180p/150 kbps @15 fps), further reduced by the receiver's rendered tile size. Audio always on, Opus DTX keeps silent participants near-zero.

W4 additions (evidence below):
- **Start bitrate.** Every connection starts its bandwidth estimate at the tier cap (`x-google-start-bitrate`)
  instead of libwebrtc's 300 kbps.
- **Codec order per tier.** Power-efficient (hardware) codecs first. Then software order: 1–2 → AV1, VP9, VP8, H264;
  3–4 and 5–10 → VP8 first. Pairs renegotiate when the participant count crosses a tier.
- **3–4 cap: amended by ADR-0008** (owner decision 2026-10-12: adaptive 600 ⇄ 800 kbps per pair). Original W4 text: Raising the 3–4 tier (and the 360p rung) from 600 to 800 kbps is recommended, but it
  is a bandwidth trade-off for the owner to decide (below).

## Alternatives considered
- Cloudflare Realtime SFU for 4+: better for HD group video, adds a dependency and integration work; revisit after V1.
- Audio-only above 4: simpler, worse product.

## Consequences
Worst case (10 people): ~9 × 150 kbps ≈ 1.35 Mbps up, nine small encodes. Signal to revisit: `group_10` profile fails CPU or bandwidth gates on mid-range phones.

## Evidence (W4 package V, 2026-10-12)
Lab: headless Chromium 156 on an M1 host shared with other agents. All runs are unshaped (no Docker, so no netem).
The corpus is synthetic: `talking_head` is a 640×360 mandelbrot zoom with a frame-ID barcode, which is much harder to
encode than a real face, so absolute VMAF is pessimistic. Every headless encoder is software
(`mediaCapabilities.powerEfficient=false` for all codecs). Reports are in `quality/reports/` (raw recordings deleted).

**Measurement fix first (V1).** The QA recorder re-encoded at Chrome's default ~2.5 Mbps, which cost about 2 VMAF. It
now records at 8 Mbps, which is transparent (8 vs 30 Mbps: ±0.1). Pipeline ceiling (6.7 Mbps loopback): VMAF 96.1.
good_wifi at the same 1.5 Mbps: 81.4 → 83.7 / 83.4. The rest is encode loss.

**Start bitrate (V2).** With `x-google-start-bitrate` at the tier cap, 2-party time from Join to 720p drops from
17.5 / 17.6 / 17.3 s to 5.4 / 5.5 / 5.4 s (first frame at 540p instead of 180p), with no overshoot over the cap.

**Knee: loopback selftest, VMAF vs sent kbps (warm-up 6 s, 15 s window).**

360p30 (2-party rung for a 360p source; tier 3–4 cap):

| kbps | VP8 | VP9 | H264 (OpenH264) | AV1 (libaom) |
|---|---|---|---|---|
| 400 | — | 63.6 | 57.1 (270p) | 69.9 |
| 600 | 67.3 (270p) | 67.7 | 63.5 (270p) | 75.0 |
| 800 | 75.6 | 74.1 | 67.3 (270p) | 78.7 |
| 1000 | 78.6 | 78.1 | 71.2 | 81.4 |
| 1500 | 83.6 | 84.3 | 79.0 | 86.2 |
| 2000 | 86.6 | 88.2 | 84.0 | 89.3 |
| enc ms/frame | 1.2–1.9 | 1.8–2.2 | 2.0–2.8 | 1.7–1.9 |

180p15 (tier 5–10 rung):

| kbps | VP8 | VP9 | H264 | AV1 |
|---|---|---|---|---|
| 100 | 48.7 | 52.4 | 41.4 | 54.9 |
| 150 | 55.0 | 57.9 | 49.5 | 59.0 |
| 250 | 60.9 | 63.5 | 58.2 | 64.5 |
| 400 | 64.8 | 68.0 | 64.6 | 68.0 |

**Mesh, in-app (good_wifi unshaped, 40 s, `?vcodec=`, received tile 270p → 400 kbps view rung).** proc CPU covers
the whole local browser process tree, encoder threads included, as % of one core per participant.

| tier | codec | VMAF | send kbps | CPU/peer | enc ms | notes |
|---|---|---|---|---|---|---|
| 4 | VP8 | 62.2 | 1290 | 57 % | 1.4 | |
| 4 | VP9 | 60.1 | 1288 | 70 % | 2.6 | |
| 4 | H264 | 36.0 | 1276 | 60 % | 2.0 | OpenH264 breaks down at 270p/400k |
| 4 | AV1 | 65.8 | 1285 | 88 % | 3.3 | |
| 10 | VP8 | 55.6 | 1626 | 49 % | 3.0 | TTFF 10 s: host saturated (load 116) |
| 10 | VP9 | 60.4 | 1438 | 68 % | 9.3 | setup failed (connect timeouts) |
| 10 | H264 | 50.1 | 1598 | 52 % | 2.4 | |
| 10 | AV1 | — | — | — | — | pages didn't load: host saturated |
The 10-party rows run 10 participants on one 8-core host (90 encodes + 90 decodes), so they show relative cost, not
device-realistic cost.

**In-app confirmation of the shipped defaults (good_wifi, unshaped, same seed):**
- Pre-W4 baseline (fab5f89): VMAF 81.41 at 1528 kbps send.
- Shipped defaults (AV1 picked by the tier order): 85.49 / 85.50 / 85.52 at 1524 kbps. Compare: win, +4.1 VMAF
  (p5 +5.2) at equal bandwidth.
- Same build at 3 participants picks VP8.
- Ramp with the AV1 default: 5.3 / 5.3 s to 720p from Join.
- diag N=4: no hard anomalies; time to target 2.3 s.

**Cap knee, in-app (3 participants, VP8, viewport 390×844@3 so the tier cap binds):**

| cap (360p rung + tier 3–4) | VMAF r1 / r2 | p5 | send kbps | received height | CPU/peer |
|---|---|---|---|---|---|
| 600 kbps (current) | 68.04 / 69.12 | 63.5 / 63.9 | 1255 | 270 (qualityLimitation=bandwidth) | 44–46 % |
| 800 kbps (candidate) | 75.09 / 74.98 | 70.2 / 70.0 | 1663 | 360 (none) | 44–49 % |

Compare: trade-off, +5.9 VMAF for +32 % send. Selftest agrees: VP8 at 360p is 67.3 → 75.6 → 78.6 for
600 → 800 → 1000 kbps, so 800 is the knee.

**Recommended policy table (owner decides the bandwidth trade-off):**

| participants | max encode | cap / peer | fps | start bitrate | software codec order | status |
|---|---|---|---|---|---|---|
| 1–2 | 720p | 1500 kbps | 30 | 1500 | AV1, VP9, VP8, H264 | shipped |
| 3–4 | 360p | 600 / 800 kbps adaptive (ADR-0008) | 30 | = cap | VP8, AV1, VP9, H264 | adaptive per pair, ADR-0008 |
| 5–10 | 180p | 150 kbps | 15 | 150 | VP8, VP9, H264, AV1 | shipped; 250 kbps would be +5.9 VMAF (VP8) at +900 kbps up for 10 people, not recommended |
Ladder rung 360p: 600 kbps (recommend 800, together with the tier change).

**Known gaps and how we'd know this is wrong:**
- Hardware encoders (VideoToolbox H264, Android MediaCodec) are untested: headless has none. A real-device run is needed.
- AV1 at 2 participants costs about 14 % more CPU than VP9. Watch `qualityLimitationReason=cpu` on mid-range Android.
- Safari has no AV1 WebRTC encode except on hardware-AV1 devices. Negotiation then falls back to VP9/VP8.
- The corpus is synthetic and very detailed, so absolute VMAF is pessimistic. Relative comparisons hold.
- No netem (no Docker on the host): loss and jitter behaviour of AV1 vs VP8 isn't measured yet (3g_lossy, bw_squeeze).
