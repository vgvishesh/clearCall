# 0004 — Rooms identified by a secret in the URL fragment; end-to-end encrypted signaling

- Status: Accepted
- Date: 2026-10-11

## Context
No accounts in V1. A link must be enough to join, short enough to share, and the one server we run should learn as little as possible.

## Decision
Link `https://<host>/c#<32-byte secret>`. Room id and signaling key are both HKDF-derived from the secret client-side; only the room id reaches the server. Peer-to-peer signaling payloads are AES-GCM encrypted with AAD binding room, sender and recipient.

## Alternatives considered
- Random room id in the path + plaintext signaling: simpler, but the server (or anyone who gets its logs) could read SDP and could MITM the DTLS handshake by swapping fingerprints.
- Separate room id in path + key in fragment: longer link, no benefit.

## Consequences
Server is blind and cannot MITM. Losing the link = losing access (fine for ad-hoc calls). Reverse cost: low (protocol version bump).
