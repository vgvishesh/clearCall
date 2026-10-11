---
name: adr
description: Record an architecture decision (ADR) in docs/adr. Use when making or changing a decision that is expensive to reverse — topology, codecs, vendors, identity, data stored, protocol major versions, min OS.
---
# adr
1. Next number: `ls docs/adr | sort | tail -1`. Copy `docs/adr/0000-template.md` to `docs/adr/NNNN-kebab-title.md`.
2. Fill Context (which CLAUDE.md requirement it touches), Decision, Alternatives (each with why it lost), Consequences (including a measurable signal that would show it was wrong, and the reverse cost).
3. Status `Proposed` until the owner accepts. Update `docs/ARCHITECTURE.md` to link it. If it supersedes one, mark the old ADR `Superseded by NNNN`.
