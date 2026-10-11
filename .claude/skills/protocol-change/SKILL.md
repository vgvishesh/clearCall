---
name: protocol-change
description: Change the signaling protocol (client⇄server or encrypted peer⇄peer messages, data-channel messages) safely across protocol/, signaling/ and web/. Use whenever adding/changing a message, field or call flow.
---
# protocol-change
1. Edit `protocol/src/messages.ts` (types + validators). Rules: additive within a version; new fields optional with documented defaults; receivers ignore unknown message types and fields (old tabs stay open for hours).
2. Breaking change → bump `PROTOCOL_VERSION`, server rejects mismatched `join` with `error{code:"version"}` and the UI shows "Please reload". Needs an ADR.
3. Add/adjust fixtures in `protocol/fixtures/*.json` (valid + invalid cases). `protocol` tests assert every valid fixture parses and every invalid one is rejected.
4. Update `protocol/FLOWS.md` if a sequence changed.
5. Implement: `signaling/` then `web/src/core/`. Both import the validators from `@clearcall/protocol` — never re-declare message shapes.
6. `make protocol-check` green, and `make e2e` if a call flow changed.
