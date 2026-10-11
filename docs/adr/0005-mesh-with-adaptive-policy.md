# 0005 — Full mesh up to 10 with a participant-count bandwidth policy

- Status: Accepted (V1)
- Date: 2026-10-11

## Context
V1 is pure P2P (no SFU). In a mesh each participant encodes and uploads one stream per peer.

## Decision
Full mesh, hard cap 10. Per-connection encode caps by participant count (2: 720p/1.5 Mbps; 3–4: 360p/600 kbps; 5–10: 180p/150 kbps @15 fps), further reduced by the receiver's rendered tile size. Audio always on, Opus DTX keeps silent participants near-zero.

## Alternatives considered
- Cloudflare Realtime SFU for 4+: better for HD group video, adds a dependency and integration work; revisit after V1.
- Audio-only above 4: simpler, worse product.

## Consequences
Worst case (10 people): ~9 × 150 kbps ≈ 1.35 Mbps up, nine small encodes. Signal to revisit: `group_10` profile fails CPU or bandwidth gates on mid-range phones.
