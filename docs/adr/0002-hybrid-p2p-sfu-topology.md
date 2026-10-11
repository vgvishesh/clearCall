# 0002 — Hybrid topology: P2P mesh ≤3, serverless SFU for 4–10

- Status: Deferred (V1 is web-only, see 0003)
- Date: 2026-10-11

## Context
Requirement: P2P, no servers, 10 participants, minimal bandwidth, works for anyone. A full mesh makes each participant upload N-1 streams and run N-1 encoders — infeasible on phones past ~4 video participants.

## Decision
Mesh for ≤3 participants. Cloudflare Realtime SFU (managed, serverless, 1,000 GB/month free egress shared with TURN) for 4–10. Seamless upgrade when the 4th person joins. Frame-level E2EE on the SFU path.

## Alternatives considered
- Pure mesh, audio-only above 4: honors "P2P" literally but fails "10-person video".
- "Super-peer" (best-connected phone forwards for everyone): no infra, but the host's uplink and battery collapse and the call dies when the host leaves.
- LiveKit Cloud: excellent native SDKs + SFU; smaller free tier, and we'd be building on their SDK's audio pipeline. Kept as the fallback if Cloudflare's raw-WebRTC API proves too costly to integrate.
- Self-hosted SFU (mediasoup/Janus/LiveKit OSS): violates "no servers we run".

## Consequences
One vendor (Cloudflare) for signaling, TURN, SFU. Signal: if free-tier egress is exceeded or SFU p95 latency > 150 ms for our users' regions, revisit. Reverse cost: medium (SFU path is isolated behind a `GroupTransport` interface).
