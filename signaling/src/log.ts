/**
 * Structured logs: one JSON line per room event. Only id prefixes, counts and codes —
 * never names, SDP, keys, IPs, credentials or relayed `data` blobs.
 */
export interface RoomLogEvent {
  evt: string;
  /** First 6 chars of the room id. */
  room: string;
  /** First 6 chars of the peer id, when the event concerns one peer. */
  peer?: string;
  /** Peers in the room (active + away) after the event. */
  n?: number;
  /** Error code or WebSocket close code. */
  code?: string | number;
}

export const short = (id: string | undefined): string => (id ? id.slice(0, 6) : "");

export function logEvent(e: RoomLogEvent): void {
  console.log(JSON.stringify(e));
}
