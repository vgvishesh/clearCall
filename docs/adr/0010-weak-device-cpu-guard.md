# 0010 — Weak devices: no software AV1/VP9 on phones, and a CPU overload guard that protects audio

- Status: Proposed (engineering decision; the owner decides on the real-device check and the 360p15 trade-off below)
- Date: 2026-10-14
- Amends: ADR-0005 (codec order per tier: 1–2 = AV1 first on capable desktops only); ADR-0007 (audio first under
  CPU starvation)

## Context
Bug report (owner, 2026-10-14): a 1:1 call, owner on an iPhone 16e (Safari / home-screen PWA) and userA on an old,
"beaten-up" Android phone (Chrome), both on home fibre Wi-Fi (300/300 and JioFiber 30/30), STUN only, staging
build 2928549 (before ADR-0008/0009). Over ~5 minutes the video went choppy, then froze, played briefly, froze again,
then the audio "vanished and turned robotic"; they switched to WhatsApp, which worked. No logs from that call exist.

A slow decline over minutes that ends in robotic audio looks like CPU or thermal overload on the weak phone, more
than a network problem. 30 Mbps symmetric is plenty for a 1.5 Mbps call. CLAUDE.md V1 #3/#5 (clean speech, quality
better than WhatsApp) and "Works on iPhone Safari / Android Chrome" are what break.

### Which codec did that call use? (analysis; no WebKit or real-device run was possible on this host)
- The joiner offers and the host answers (peer-session.ts). Per JSEP both directions send the first codec of the
  **answer**, so the host's preference order decides the codec for both directions, filtered to what the offer lists.
- Before this ADR, every device used the same 1:1 order: power-efficient (hardware) codecs from
  `mediaCapabilities.encodingInfo({type:"webrtc"})` first, then software **AV1, VP9, VP8, H264**.
  - If the iPhone answered with hardware H264 first (Safari reports H264 as power-efficient where the API answers),
    both directions ran H264. On an old Android without a Chrome-enabled H264 hardware encoder, that is OpenH264
    in software at 720p30.
  - If Safari's `encodingInfo` doesn't answer for `webrtc` or claims nothing, the iPhone falls back to the
    software order. Its answer then puts AV1 (A18 has AV1 decode; whether WebKit offers AV1 for WebRTC on iOS is
    unverified) or VP9 first.
  - If the Android hosted, its own order (AV1 first unless hardware is reported) decided.
- Every one of those paths can leave the old phone encoding **and** decoding a 720p30 stream in software, and the
  likely ones mean software AV1 or VP9. Nothing in the old build ever stepped down for CPU, and the receiver's
  decoder had no feedback path at all.

### Evidence (lab, 2026-10-14, branch fix/home-broadband-call-quality)
Setup: netem lab on Docker Desktop (4-vCPU VM). New lab options: `--cpus p1=<cores>` (docker `--cpus` on one peer's
container, which starves the whole browser: encoder, decoder, audio threads) and `--hd` (a 1280×720 upscale of the
synthetic corpus as the camera, as real phones capture 720p; VMAF still scored at 360p). Clean link (`good_wifi`),
120 s. The host was shared with other agents (load 8–18), so the claims rest on interleaved same-build A/B pairs
(`?cpuguard=0` = main's behaviour). "Remote's audio concealment" = concealment at p0 of the audio p1 sends. That is
what the iPhone user heard.

**1. Software AV1 is ~8× the encode cost of VP8/H264 on a starved peer, and Chrome never says so** (one peer at 1
core, codec forced per run, main's code):

| codec | encode ms/frame | worst recv fps | freeze | remote's audio concealment | PESQ | VMAF |
|---|---|---|---|---|---|---|
| AV1 (1:1 default) | 33.4 | 20.3 | 5.4 % | 2.90 % | 1.13 | 83.1 |
| VP8 | 4.1 | 28.7 | 2.0 % | 0.42 % | 1.36 | 79.8 |
| H264 (OpenH264) | 4.1 | 28.5 | 3.6 % | 0.11 % | 1.44 | 80.1 |
| AV1, no CPU limit (control) | 18.9 | 27.4 | 4.2 % | 0.29 % | 1.58 | 85.0 |

`qualityLimitationReason` was never `cpu` in any run, even at 100–290 ms/frame, so libwebrtc's own CPU adaptation
never engaged.

**2. Once a device is starved enough, no codec saves the call: video has to step down.** At 0.5 core, AV1 and VP8
both collapse. Remote concealment is 59 % (AV1) and 58 % (VP8), send fps 8–9, and RTT rises 3–7× (packets queue
behind the starved process). Per 10 s bucket the AV1 baseline conceals **47–78 % in every bucket**. That matches
"audio vanished and turned robotic". With the guard, reduced 360p15 VP8 buckets drop to **0 %** for 50 s at a time.
Recovering to 720p30 brought 68–84 % straight back.

**3. Iterations (each one measured, see commits):**
- v1: codec fallback, then reduced, then paused, as separate steps, with a 30 s recovery. After the codec switch,
  VP8 restarted at 720p on the starved peer at 100–290 ms/frame for ~8 s. Each 30 s recovery re-overloaded within
  10 s, so the guard flapped. Remote concealment got worse than baseline in one run (6 % vs 2.9 %).
- v2: codec fallback and reduced in one step, recovery after 60 s with doubling backoff, and the level kept after two
  failed recoveries. Overload is judged against the camera's actual frame rate. A/B below.
- v3: the camera rate collapses with the encoder on a starved device (camera 8–11 fps, sent 7–10, encode
  60–250 ms), which delayed detection by 30 s. Encode time ≥ 75 % of the frame interval now counts as overload on
  its own.

**4. Interleaved A/B (v2; `old` = `?cpuguard=0` = main):**

| run | remote's audio concealment | freeze | worst recv fps | VMAF | send kbps |
|---|---|---|---|---|---|
| 1 core old #1 | 25.25 % | 12.7 % | 12.5 | 83.2 | 1414 |
| 1 core new #1 | **3.75 %** | 7.6 % | 17.0 | 77.2 | 938 |
| 1 core old #2 | 18.56 % | 10.6 % | 14.6 | 83.5 | 1436 |
| 1 core new #2 | **3.00 %** | 6.9 % | 20.4 | 80.3 | 1235 |
| 0.5 core old #1 | 63.24 % | 12.7 % | 7.0 | 83.2 | 1487 |
| 0.5 core new #1 | **18.71 %** | 8.2 % | 11.9 | 72.0 | 806 |
| 0.5 core old #2 | 60.24 % | 20.5 % | 5.7 | 83.4 | 1280 |
| 0.5 core new #2 | **21.89 %** | 13.1 % | 11.2 | 74.7 | 897 |

**5. Final build** (v3 detection plus headroom-gated recovery for the 0.5/1-core "v4" rows; same session, interleaved):

| run | remote's audio concealment | freeze | worst recv fps | VMAF | send kbps | guard actions (starved peer) |
|---|---|---|---|---|---|---|
| v3 1 core old | 7.97 % | 14.1 % | 17.5 | 82.9 | 1267 | — |
| v3 1 core new | **3.64 %** | 7.1 % | 14.2 | 72.9 | 715 | reduced at 13.6 s; recovery probe at 75 s re-overloaded |
| v3 0.5 core old | 60.73 % | 30.6 % | 5.4 | 87.8 | 1414 | — |
| v3 0.5 core new | **15.60 %** | 14.7 % | 11.8 | 70.9 | 654 | reduced at 11.4 s; time-only recovery at 72 s cost 32–43 % for ~20 s |
| v4 1 core old | 27.02 % | 12.7 % | 11.8 | 84.8 | 1387 | — |
| v4 1 core new | **3.25 %** | 7.3 % | 16.0 | 76.9 | 830 | reduced at 38.6 s; headroom (2.5 ms) → one probe at 99.5 s → reduced again (backoff) |
| v4 0.5 core old | 56.30 % | 11.6 % | 7.1 | 82.9 | 1475 | — |
| v4 0.5 core new | **9.06 %** | 12.5 % | 12.5 | 74.0 | 649 | reduced at 11.1 s; no recovery probe (360p at 3.5–8 ms: no headroom) |

Reports: `quality/reports/20261014-23*-good_wifi-{ab1,ab2,v3}-*`, `20261015-004*-good_wifi-v4-*`. In the 0.5-core run
the remaining concealment is the first ~10 s on AV1 before the trigger, plus 0–19 % buckets while the device stays
borderline at 360p15. The "paused" step never triggered in the lab: the overload bar at 15 fps (encode ≥ 50 ms, or
≥ 27 ms with fps < 12.75) wasn't sustained. It is covered by E2E (`e2e/tests/cpu-guard.spec.ts`, QA fault
`cpu-overload`, two real Chromium peers: VP8 + ≤ 360p both ways, then paused, camera reported off, audio flowing).

PESQ stays ~1.1 in both arms under starvation (the scorer saturates). Concealment is the discriminating audio metric.
VMAF falls 3–11 because video is deliberately 360p15. That is the trade: video goes from choppy and freezing to
smooth and smaller, and audio stays clear.

## Decision
1. **Constrained devices never negotiate software AV1/VP9** (`codecs.constrainedDevice`, `heavyExclusions`).
   - Constrained = mobile UA (Android, iPhone, iPad UA, "Mobile"), `hardwareConcurrency ≤ 2`, or `deviceMemory ≤ 4`.
   - Those codecs are *removed* from our `setCodecPreferences`, not just moved down, so they are absent from our offer
     and our answer and neither direction can use them, whoever answers.
   - A power-efficient (hardware) AV1/VP9 is kept, and a lab-forced `?vcodec=` is never excluded.
   - Order on such devices: hardware codecs, then VP8, then H264.
2. **CPU overload guard** (`web/src/core/cpu-guard.ts`, per device, driven by the 1 Hz stats sampler):
   - **Overloaded sample:** encode ≥ 75 % of the frame interval; or encode ≥ 40 % *and* sent fps < 85 % of the
     expected rate (expected = target, or the camera rate if lower at the normal level); or `cpu` limitation; or the
     sampler ran ≥ 2.5 s late (main thread starved). Hidden tabs are ignored.
   - **Trigger:** ≥ 6 of the last 10 samples.
   - **Step 1, "reduced":** ≤ 360p and 15 fps on every sender, plus a view report capped at 360 so peers send us
     ≤ 360p. In the same step, software AV1/VP9 are excluded and the pair renegotiates. Caps are applied before the
     codec switch, so the new encoder starts small.
   - **Step 2, "paused":** video encodings inactive and view 0 (peers stop sending us video). The camera is announced
     off, so peers show the avatar rather than a frozen frame. The UI shows "Video paused to keep your audio clear".
     Audio continues.
   - **Recovery:** one level per 60 s with at most 1 overloaded sample in 10. From "reduced" this also needs encode
     headroom: the median 360p encode must be ≤ 3.3 ms/frame, because 720p30 costs ~4× per frame. Each overload right after a recovery
     doubles the wait, and after two such failures the level is kept for the call. Rebuilt pcs inherit the state.
   - **Observability and control:** `video.cpuLevel` in QA stats, a `cpu guard` log line per action,
     `CallState.videoLimited`, `?cpuguard=0` (lab A/B), `?devclass=constrained|normal` (lab), and the QA fault
     `inject("cpu-overload")` (E2E).
3. **Not adopted:**
   - **Dropping AV1 for every 1:1.** Desktops keep ADR-0005's +2–3 VMAF at equal bitrate. The guard catches a
     desktop that can't keep up.
   - **Audio `priority`/`networkPriority: "high"`.** Under CPU starvation the audio loss is scheduling, not
     bandwidth. Chrome's bitrate priority only changes allocation under a congested estimate, and audio already gets
     its share there (ADR-0009 3g_lossy: concealment 1.6–3.4 %). It is cheap but unmeasured, so it is left for a
     data-backed change.
   - **Lower 1:1 start resolution on all phones.** Phones with a hardware encoder (most iPhones, many Androids)
     handle 720p30 well, and the guard reacts within ~10 s when they can't.

## Alternatives considered
- **Rely on libwebrtc's CPU adaptation.** The lab never saw `qualityLimitationReason=cpu`, even at 290 ms/frame,
  and it doesn't cover the decoder.
- **Codec switch only (v1 step 1).** Measured: the new encoder restarts at 720p and the device stays overloaded.
- **Fast recovery (30 s).** Measured: it flaps, and every switch costs keyframes.
- **Per-pair guard.** The CPU is per device, and one starved device hurts every pair it sends on.

## Consequences
- Weak phones get ≤ 360p15 video in place of choppy 720p, and audio that stays intelligible. In the worst case
  (very weak or thermally throttled) the call goes audio-only with a calm notice and comes back when the device
  cools.
- Phones never use software AV1/VP9. Two phones on software codecs call each other with VP8.
- **Signals that this is wrong:**
  - `cpu guard` log lines or `videoLimited` on desktops with healthy encode times (false positives). Check
    `video.cpuLevel` in diag bundles.
  - Phones with a hardware AV1/VP9 encoder not being reported power-efficient, which costs quality on capable phones.
  - Remote concealment still high on real weak phones while the guard reads them as healthy.
- **Cost to reverse:** `constrainedDevice` → null and `cpuGuard: false` in the controller (two lines). `?cpuguard=0`
  and `?devclass=normal` reproduce the old behaviour for A/B.
- **Not verified:**
  - Real iPhone ⇄ old Android negotiation and CPU behaviour (this host can't run WebKit or real devices). Owner
    check below.
  - Thermal throttling over minutes. The lab starves at a fixed level.
  - The lab's own recorder runs on the starved peer, adding load that a phone wouldn't have. It affects both arms
    equally.

## Home Wi-Fi hypothesis (secondary)
The first hypothesis was a realistic home Wi-Fi path. New profiles:
- `home_wifi`: 30 Mbps, RTT ≈ 70 ms, heavy-tailed `paretonormal` jitter ±25 ms, 1 % Gilbert loss.
- `home_wifi_busy`: the same, plus an 800 ms router queue and someone else's upload squeezing the uplink to
  1.2 / 0.8 Mbps twice.

New lab profile fields: `jitter_distribution`, `queue_ms`. Netem, uplink shaping only, 90 s.
"Staging" = `?cpuguard=0&vmin=0&vmax=0` (the 2928549 behaviour for 1:1, per ADR-0009). "Main" = `?cpuguard=0`.

| profile / build | VMAF | freeze | remote's audio concealment | send kbps | guard actions |
|---|---|---|---|---|---|
| home_wifi staging ×3 | 87.6 / 85.8 / 86.1 | 3.7 / 5.7 / 1.7 % | 0.41 / 0.31 / 0.84 % | 1633 / 1652 / 1579 | — |
| home_wifi main ×2 | 82.7 / 79.2 | 5.2 / 4.6 % | 0.31 / 0.46 % | 1224 / 1196 | — |
| home_wifi new ×3 | 84.1 / 76.3 / 85.9 | 3.8 / 7.7 / 4.8 % | 0.85 / 0.34 / 0.32 % | 1393 / 1268 / 1426 | none |
| home_wifi main, no ceiling (`vmax=0`) | 86.2 | 5.4 % | 0.43 % | 1598 | none |
| home_wifi main, no floor (`vmin=0`) | 84.3 | 5.6 % | 0.40 % | 1355 | none |
| home_wifi_busy staging / main / new | 69.2 / 74.2 / 69.8 | 8.0 / 6.1 / 10.6 % | 1.08 / 1.29 / 0.53 % | 685 / 657 / 515 | none |

- **Not the cause of the reported call.** The staging-like build stays fine on a jittery 30 Mbps home Wi-Fi path:
  VMAF 86–88, audio concealment < 1 %, no estimate collapse. With heavy cross-traffic and bufferbloat, video
  degrades in every arm while audio stays usable (≤ 1.3 %). The jitter collapse that ADR-0009 found on 3g_lossy
  doesn't happen at this capacity.
- **Finding for ADR-0009 (owner trade-off, not changed here).** On home Wi-Fi, main's congestion-controller ceiling
  (`x-google-max-bitrate` 1832 kbps) costs ~4–5 VMAF against the staging behaviour, at ~20–25 % less upload. Without
  the ceiling, main is back to 86.2. These are single runs with wide spread, so it needs repeats before anyone acts
  on it. ADR-0009 adopted the ceiling for 4g_typical probe overshoot.
- **No regressions** (`pnpm compare`, main → new):
  - good_wifi: **win**. VMAF −0.5 (noise), send −5 %, concealment 0.30 → 0.08 %.
  - 3g_lossy: equal VMAF and freezes. PESQ −0.06 is at the noise edge with the guard idle (same code path).
  - The guard never acted in any network-only run.
