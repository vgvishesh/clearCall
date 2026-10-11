# protocol/ — the signaling contract
`signaling.schema.json` (JSON Schema 2020-12) + `fixtures/*.json` + `VERSION` + `FLOWS.md`.
Any change: `protocol-change` skill. All three implementations must round-trip every fixture (`make protocol-check`).
