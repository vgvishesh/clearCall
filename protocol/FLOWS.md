# Signaling & connection flows (v1) — normative

Terms: **N** = newcomer, **E** = existing peer, **S** = server (Room DO). "pair" = one RTCPeerConnection between two peers.
Per remote peer, a client processes incoming signals **strictly in order through a per-peer async queue** (decryption is async; never let an `ice` overtake its `sdp`, or anything run before the pair exists).

## 1. Join and pair setup — the newcomer offers, the existing peer answers
```
N → S : join {v, peerId:N}
S → N : welcome {peers:[E1..En] (join order, incl. away peers), iceServers, resumed:false}
S → Ei: peer-joined {N}
N → Ei: signal(enc hello{name})            Ei → N: signal(enc hello{name})   (Ei sends on peer-joined)
N (offerer for every pair it initiates):
   pc = new RTCPeerConnection({iceServers})
   addTransceiver(audioTrack|"audio", {direction:"sendrecv"}); addTransceiver(videoTrack|"video", {direction:"sendrecv"})
   createDataChannel("ctl", {negotiated:true, id:0})
   → negotiationneeded → signal(enc sdp offer)
Ei (answerer) on the first offer from N:
   pc = new RTCPeerConnection; setRemoteDescription(offer)
   take pc.getTransceivers() — exactly one audio + one video (matched by receiver.track.kind) —
   set direction="sendrecv", sender.replaceTrack(localAudio/localVideo or null)
   createDataChannel("ctl", {negotiated:true, id:0})   // after SRD, so it causes no extra negotiation
   setLocalDescription() → signal(enc sdp answer)
Both trickle signal(enc ice) …; "ctl" opens → both send state{name,mic,cam,mode}
```
- The answerer **never** calls `addTransceiver` for a pair. Invariant (unit-tested): every pair has exactly 3 m-lines (audio, video, application), even after glare.
- Later renegotiations (codec/mode changes, ICE restarts) use **perfect negotiation** with polite = lexicographically smaller peerId.
- Camera off/on and mic mute never renegotiate: `replaceTrack(null|track)` / `track.enabled`.

## 2. Hello semantics — hello resets a pair
Receiving `hello` from a peer you already hold a pair with means that peer has a **fresh connection state** (reload, rebuilt pair): close and discard the old pair, then:
- if you are N for that peer (you received `peer-joined` *after* your own `welcome`, i.e. it's newer than you), you are the answerer and wait for its offer;
- otherwise (you learned about it from `welcome.peers`), you are the offerer: create the pair and offer.
Rule of thumb: **whoever learned about the other from `welcome.peers` offers**. `hello` from an unknown peer that is not in the roster is ignored until `peer-joined`.
- The role is fixed when a peer is first learned and **never changes** for that roster entry (a resume does not make anyone an offerer), so both sides always agree.
- A `hello` on a pristine pair (nothing received from that peer yet) does not reset it; if we are the offerer and our offer has been outstanding ≥ 3 s, we re-send that same offer and its candidates (the peer probably rebuilt after losing it). An answerer receiving the offer it already answered re-sends its answer. Both are idempotent.
- **Stalled negotiation** (offer or answer lost): at the 20 s connect timeout, a pair that never completed negotiation (offerer still in `have-local-offer`, or answerer that never got an offer) is discarded and rebuilt with a `hello`. ICE restart (§6) is only for pairs that were connected or have both descriptions; before the first connect only the offerer drives recovery, the answerer falls back to a rebuild after a second 20 s window.
- An offer whose `o=` session id differs from the remote description of a used answerer pair comes from a replaced remote pc: the answerer rebuilds its pair and answers (keeps 3 m-lines).

## 3. Leave
`leave` (+ ctl `bye` best-effort; on `pagehide` the client sends both) → S broadcasts `peer-left{reason:"left"}` → everyone closes that pair and removes the participant.
- On `pagehide` the client writes `leave` to the socket **first and synchronously** (no await, nothing queued before it), then the ctl `bye`s. Nothing after the handler returns is guaranteed to run.
- Firefox closes the page's WebSocket (code 1001) on navigation **before** `pagehide` fires, so `leave` cannot be sent there; the ctl `bye` still reaches every peer with an open channel, but S keeps the old peerId away for the grace window (§5).

## 4. Signaling drop + resume (same tab)
- peerId lives **in memory only** (never storage). Socket closes → S marks the peer away (`awayUntil = now + RESUME_GRACE_SECONDS`), still counted toward capacity, still listed in `welcome.peers` for newcomers.
- Client reconnects with jittered backoff and sends `join{peerId, resume:true}`:
  - `welcome{resumed:true}` → no broadcasts. The client diffs `welcome.peers` with its participants: removes participants not listed (it missed their `peer-left`); keeps pairs that are connected, or connecting with both descriptions; every other listed pair (lost offer/answer, ICE disconnected/failed, dropped on `unknown-peer`) is discarded and rebuilt with `hello`, **keeping its original role** (§2). A listed peer it doesn't know joined while it was away (it missed `peer-joined`): that peer learned us from its `welcome.peers`, so it offers and we answer — our `hello` makes it (re)offer.
  - Signals still queued in the outbox for a pair that gets rebuilt are dropped (they belong to the discarded pc); the rest of the outbox is flushed in order, and new signals never overtake it.
  - `welcome{resumed:false}` (grace expired; S treated it as a fresh join and broadcast `peer-joined`) → the client discards all pairs and rebuilds from `welcome.peers` as a newcomer.
- Media keeps flowing P2P while signaling is down; ICE restarts wait until signaling is back.
- Before the first `welcome` the client gives up after ~20 s (UI error `signaling-unavailable`). Once joined it keeps reconnecting (backoff capped at ~30 s, phase `reconnecting`) as long as any pair is connected, and ends the call (`signaling-unavailable`) only after 60 s with neither signaling nor a connected pair.
- Signals to a peer that is away or unknown get `error{code:"unknown-peer", peerId}` (non-fatal): drop queued work for that pair; it will be rebuilt on its `hello`.
- **Hidden until heard.** A peer listed in a `welcome.peers` that we have never received a signal from is not shown (not in `CallState.participants`, not counted by the bandwidth policy) while our `hello` probes it: an active peer says hello on its own `peer-joined` and answers within a round trip. If S answers `unknown-peer` (and we hold no connected pair with it) it stays **hidden but kept in the roster** — it is away, typically our own peerId from before a reload whose `leave` was lost (§5). It becomes visible on **any** signal from it (a resuming peer sends `hello` to everyone it has no pair with) or on `peer-joined`, and is dropped for good on `peer-left`. A probed peer that neither signals nor draws `unknown-peer` within 2 s is shown anyway. While the first welcome's peers are being probed the client stays in phase `joining`, so the call screen never flashes a ghost tile or an empty room.
- S detects silently dead sockets via `getWebSocketAutoResponseTimestamp` (> 4 × HEARTBEAT_INTERVAL_MS ⇒ away; 2× proved too tight under load). The client pings every HEARTBEAT_INTERVAL_MS and treats its socket as dead after 3 × HEARTBEAT_INTERVAL_MS (45 s, `HEARTBEAT_DEAD_AFTER_MS`) without any message *and* ≥ 2 unanswered pings, then resumes — before the server's cutoff, so a half-open socket usually recovers with no presence change.

## 5. Reload = new participant
A reload is a fresh join with a new peerId. The old peerId times out after the grace window (or leaves immediately if `pagehide` delivered `leave`). Others see the old tile disappear within ≤ 20 s (at once when the ctl `bye` arrived) and a new tile appear.
The reloaded tab may find its own old peerId in `welcome.peers` (it was away, §3): it never shows it — the hidden-until-heard rule (§4) keeps it out of the participants until its `peer-left{timeout}`.

> Decision (2026-10-11): the server does **not** treat close code 1001 ("going away") as a leave. Firefox sends 1001 on reload (its `leave` never goes out), but mobile browsers may also close with 1001 when the app is backgrounded while P2P media continues — e.g. switching to WhatsApp to share the link. Ghosts are handled client-side instead (ctl `bye` + hidden-until-heard).

## 6. Network change / ICE restart
- Only the **impolite** side (larger peerId) initiates: on `connectionState=failed`, or `disconnected` for > 4 s → `pc.setConfiguration({...,iceServers: latest welcome.iceServers})` → `restartIce()` → offer. The polite side initiates only if nothing happened within a further 4 s.
- Max 3 restarts per pair with backoff; then status `failed` ("Can't connect · Retry"). `retryPeer` → discard the pair and send `hello` (§2 rebuild).

## 7. Errors
Close codes: `CLOSE` in `messages.ts` (1000 left · 4001 room-full · 4002 version · 4003 duplicate-peer · 4004 replaced — never reconnect · 4005 abuse — may resume · 4006 dead socket — resume). Any other close: reconnect with `resume:true`.

`room-full` (11th; away peers count), `version` (→ UI "Please reload"), `duplicate-peer` (same peerId active and not resuming) are fatal: S closes the socket. `rate-limited`, `too-large`, `bad-message`, `not-joined`, `unknown-peer` are non-fatal.
