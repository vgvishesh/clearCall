# Clearcall

High-fidelity voice and video calls in the browser, peer to peer. Start a call, share the link, others tap it and
they're in — no accounts, no app install, no media servers.

- **Up to 10 people**, full mesh. Full video up to 4, adaptive thumbnails for 5–10.
- **Clean speech** (noise suppression, echo cancellation) by default; **Music mode** (stereo Opus 96 kbps) for music.
- **Low bandwidth for the quality**: per-tier codec choice (AV1 1:1, VP8 groups), adaptive bitrate, budgets enforced
  by an automated quality lab (VMAF, PESQ, DNSMOS, shaped networks).
- **Installable PWA** for iPhone, Android and desktop (Safari, Chrome, Firefox).
- **Private by design**: the call link's `#secret` never leaves your device. The server derives nothing readable from
  it — it relays end-to-end encrypted signaling and never sees media, names or keys.

## How it works
```
Browser A ──wss (AES-GCM-encrypted signaling)──▶ Cloudflare Worker + Durable Object ◀──wss── Browser B
    │                                              (room per link, forwards blindly)            │
    └───────────── audio/video/data: WebRTC, DTLS-SRTP over UDP, direct P2P ────────────────────┘
                    (optional TURN relay on strict networks — still end-to-end encrypted)
```
The whole backend is one Cloudflare Worker (free tier): it serves the app, introduces participants, relays their
encrypted setup messages and, if configured, mints TURN credentials. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
decisions in [docs/adr/](docs/adr/).

## Quick start
```
corepack enable && make install
make dev            # http://localhost:8787
```
**Deploy your own** (free Cloudflare account): `cd signaling && npx wrangler login`, then `make deploy-staging`.
**TURN relay** (optional, for strict networks): `make turn-setup` then `make turn-check URL=…`.
Full guide: [docs/SETUP.md](docs/SETUP.md).

## Repo
| Path | What |
|---|---|
| `web/` | Vite + Preact + TypeScript PWA. `src/core/` call engine, `src/ui/` screens. ~47 KB gzipped first load. |
| `signaling/` | Cloudflare Worker + Room Durable Object (WebSocket hibernation). |
| `protocol/` | Shared message types, validators and link crypto (`@clearcall/protocol`). |
| `e2e/` | Playwright multi-participant call tests (Chromium, Firefox, WebKit). |
| `quality/` | Media quality lab: reference media, scorers, netem network profiles, thresholds. |
| `scripts/`, `Makefile` | Every command (`make verify`, `make e2e`, `make quality PROFILE=…`, `make diag`). |
| `.claude/` | The agentic harness (hooks, skills, agents) this project is built with — see `CLAUDE.md`. |

## Status
V1 core works end to end: 2–10 party calls, reconnect/resume, music mode, adaptive quality; E2E green on Chromium,
Firefox and WebKit. In progress: resilience on lossy mobile links. Planned: SFU transport for large calls, ML noise
suppression, push ringing. Progress: [docs/PLAN.md](docs/PLAN.md).
