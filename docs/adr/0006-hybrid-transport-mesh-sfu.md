# 0006 — Hybrid media transport: P2P mesh for small calls, SFU when load demands

- Status: Accepted (owner direction 2026-10-11); SFU implementation scheduled after V1 core
- Date: 2026-10-11
- Refines: 0005

## Context
Owner wants the app to run either peer-to-peer or "web based (if load is more)". Mesh is ideal for 2–4 people (lowest latency, zero server cost); beyond that each phone's uplink and encoder scale with N-1.

## Decision
The call engine talks to a `MediaTransport` interface (`web/src/core/transport/`): `MeshTransport` (V1) and `SfuTransport` (Cloudflare Realtime SFU, later). The controller picks the transport per call:
- mesh while participants ≤ 4 and every peer's uplink keeps up (no sustained `qualityLimitationReason=bandwidth|cpu`);
- switch the whole room to SFU when a 5th person joins with video, or when the room's measured load exceeds the mesh budget. The switch is coordinated via signaling (a room-level `transport` message, protocol v1 additive) and is make-before-break.
- the UI never knows which transport is active (`QaHook.transport()` exposes it for tests).

## Alternatives considered
- Mesh only (0005): simplest; fails the "10 people with good video on phones" bar.
- SFU always: server dependency and egress cost even for 1:1, extra latency.

## Consequences
Clean seam now, small cost (an interface). The SFU needs Cloudflare Realtime app credentials from the owner and a deployed Worker to mint sessions — it can't be exercised fully offline. Signal it was wrong: SFU p95 RTT or switch glitches worse than mesh at 5–10 people in the lab.
