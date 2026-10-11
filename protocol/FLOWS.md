# Signaling flows (v1)

## Join (newcomer N, existing peers E1..En)
```
N  → S : join {v, peerId:N}
S  → N : welcome {peers:[E1..En], iceServers}
S  → Ei: peer-joined {N}
N  → Ei: signal(enc hello{name})          Ei → N: signal(enc hello{name})
N  creates RTCPeerConnection per Ei, adds tracks → negotiationneeded → signal(enc sdp offer)
Ei → N : signal(enc sdp answer); both trickle signal(enc ice) ...
data channel "ctl" (negotiated id 0) opens → both send state{name,mic,cam,mode}
```
Existing peers also create their RTCPeerConnection on `peer-joined`; perfect negotiation (polite = smaller peerId) resolves glare if both offer.

## Leave
`leave` (or ctl `bye`) → S broadcasts `peer-left{reason:"left"}` → everyone closes that connection.

## Signaling drop + resume
Socket closes → S marks peer away, alarm in 20 s. Client reconnects with backoff: `join{peerId, resume:true}` → `welcome{resumed:true}`; no leave/join broadcasts. Media keeps flowing P2P meanwhile. After 20 s without resume → `peer-left{reason:"timeout"}`.

## Network change
`connectionState` failed (or disconnected > 4 s) → `restartIce()` → new offer via signaling. 3 failed restarts → peer shown as "Can't connect" with Retry.

## Errors
`room-full` (11th joiner), `version` (protocol mismatch → "Please reload"), `duplicate-peer` (same peerId already active and not resuming) are fatal: server closes the socket.
