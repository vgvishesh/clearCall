# 0003 — V1 is a web app (PWA) only

- Status: Accepted (owner, 2026-10-11)
- Date: 2026-10-11

## Context
The owner wants zero cost. Native iOS distribution and ringing (PushKit/CallKit) require the $99/yr Apple Developer Program; sideloaded Android faces developer-verification rules from 2026–27. Link-based calls shared over WhatsApp need no install at all.

## Decision
Build one installable web app (Preact/Vite PWA) served by a Cloudflare Worker. Calls are joined by link. Native apps are parked.

## Alternatives considered
- Native iOS + Android (ADR-0001): best ringing/audio control, costs money, 2–3 codebases.
- Native Android + web for iPhone: still two codebases for V1.

## Consequences
One codebase, zero distribution cost, works on desktop too. We give up: ringing when the app is closed (V1 has no ringing at all), custom audio processing beyond what browsers expose + WASM, guaranteed background behavior on iOS. Signal to revisit: owner pays for Apple program, or the iPhone background-audio spike shows calls drop when users switch apps.
