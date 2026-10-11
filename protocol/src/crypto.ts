/**
 * Call-link secrets, room-id derivation and end-to-end encryption of signaling payloads (ADR-0004).
 * Pure WebCrypto: runs in browsers, Cloudflare Workers and Node ≥ 20.
 *
 *   link   = https://<host>/c#<secret>          secret = 32 random bytes, base64url (43 chars)
 *   roomId = b64url(HKDF(secret, info="clearcall/v1/room-id", 16 bytes))[0..22]
 *   key    = HKDF(secret, info="clearcall/v1/signal-key") → AES-GCM-256 (non-extractable)
 *   blob   = b64url(iv(12) ‖ AES-GCM(key, iv, plaintext=JSON(payload), aad="clearcall/v1|roomId|from|to"))
 */

import { PEER_ID_RE, parseSignalPayload, ROOM_ID_RE, type SignalPayload } from "./messages.ts";

export const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const HKDF_SALT = new TextEncoder().encode("clearcall/v1/salt");
const enc = new TextEncoder();
const dec = new TextDecoder();

// ── base64url ──
export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

// ── ids & secrets ──
export function generateSecret(): string {
  return toBase64Url(randomBytes(32));
}

/** 12 random bytes → 16 base64url chars. */
export function generatePeerId(): string {
  return toBase64Url(randomBytes(12));
}

export const isValidSecret = (s: string): boolean => SECRET_RE.test(s);
export const isValidRoomId = (s: string): boolean => ROOM_ID_RE.test(s);
export const isValidPeerId = (s: string): boolean => PEER_ID_RE.test(s);

/** Build the shareable link. `origin` like "https://clearcall.example". */
export function buildCallLink(origin: string, secret: string): string {
  return `${origin.replace(/\/$/, "")}/c#${secret}`;
}

/** Extract the secret from a full link, a "/c#…" path, or a bare hash. Returns null when absent/invalid. */
export function parseCallLink(input: string): string | null {
  const hashIndex = input.lastIndexOf("#");
  const candidate = (hashIndex >= 0 ? input.slice(hashIndex + 1) : input).trim();
  return isValidSecret(candidate) ? candidate : null;
}

// ── key derivation ──
async function hkdfBaseKey(secret: string): Promise<CryptoKey> {
  if (!isValidSecret(secret)) throw new Error("invalid call secret");
  return crypto.subtle.importKey("raw", fromBase64Url(secret), "HKDF", false, ["deriveBits", "deriveKey"]);
}

export async function deriveRoomId(secret: string): Promise<string> {
  const base = await hkdfBaseKey(secret);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: enc.encode("clearcall/v1/room-id") },
    base,
    128,
  );
  return toBase64Url(new Uint8Array(bits)).slice(0, 22);
}

export async function deriveSignalKey(secret: string): Promise<CryptoKey> {
  const base = await hkdfBaseKey(secret);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: enc.encode("clearcall/v1/signal-key") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface RoomKeys {
  secret: string;
  roomId: string;
  key: CryptoKey;
}

export async function deriveRoomKeys(secret: string): Promise<RoomKeys> {
  const [roomId, key] = await Promise.all([deriveRoomId(secret), deriveSignalKey(secret)]);
  return { secret, roomId, key };
}

// ── payload encryption ──
const aad = (roomId: string, from: string, to: string) => enc.encode(`clearcall/v1|${roomId}|${from}|${to}`);

export async function encryptSignal(
  keys: RoomKeys,
  from: string,
  to: string,
  payload: SignalPayload,
): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(keys.roomId, from, to) },
    keys.key,
    enc.encode(JSON.stringify(payload)),
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return toBase64Url(out);
}

/** Returns null if the blob is malformed, was tampered with, or wasn't addressed from→to in this room. */
export async function decryptSignal(
  keys: RoomKeys,
  from: string,
  to: string,
  blob: string,
): Promise<SignalPayload | null> {
  try {
    const bytes = fromBase64Url(blob);
    if (bytes.length < 12 + 16) return null;
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad(keys.roomId, from, to) },
      keys.key,
      bytes.slice(12),
    );
    return parseSignalPayload(dec.decode(pt));
  } catch {
    return null;
  }
}
