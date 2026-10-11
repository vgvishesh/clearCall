---
name: protocol-change
description: Change the signaling protocol (messages between apps and the Worker) safely across all implementations. Use whenever adding/changing a signaling message, field, or call flow.
---
# protocol-change
The protocol is the only code-level contract between three independent implementations. Drift = calls that fail only between certain platforms.

1. Edit `protocol/signaling.schema.json`. Rules: additive changes only within a major version; new optional fields must have documented defaults; unknown message types must be ignored by receivers (forward compatibility — old apps stay in the field for months).
2. Bump `protocol/VERSION` (minor for additive, major for breaking — breaking needs an ADR and a migration window).
3. Add/adjust fixtures in `protocol/fixtures/<message>.<case>.json` — at least one valid example per new message, plus edge cases (max sizes, optional fields absent, unknown extra field).
4. Update `protocol/FLOWS.md` sequence diagrams if a flow changed (call setup, ring, join, topology upgrade, rekey, hangup).
5. Implement in order: `signaling/` → `ios/Signaling/` → `android/.../signaling/`. Each has a `ProtocolConformance` test that loads **every** fixture and asserts decode → encode → JSON-equal.
6. `make protocol-check` must be green. Then `make verify`.
