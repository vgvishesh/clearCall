// Shared types/constants. Kept out of src/index.ts: the main module may only export handlers and classes.

/** Generated bindings (worker-configuration.d.ts) plus optional secrets. */
export interface Env extends Cloudflare.Env {
  /** Optional Cloudflare Realtime TURN credentials (secrets). Without them, STUN only. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

/** Header the Worker uses to tell the Room DO its own id (for log prefixes). Client values are overwritten. */
export const ROOM_HEADER = "X-Clearcall-Room";
