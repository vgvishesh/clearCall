import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCallLink,
  decryptSignal,
  deriveRoomKeys,
  encryptSignal,
  fromBase64Url,
  generatePeerId,
  generateSecret,
  isValidPeerId,
  isValidRoomId,
  parseCallLink,
  parseClientMessage,
  parsePeerMessage,
  parseServerMessage,
  parseSignalPayload,
  toBase64Url,
} from "../src/index.ts";

const load = (kind: "valid" | "invalid", name: string): unknown[] =>
  JSON.parse(readFileSync(new URL(`../fixtures/${kind}/${name}.json`, import.meta.url), "utf8"));

const parsers = {
  client: parseClientMessage,
  server: parseServerMessage,
  "signal-payload": parseSignalPayload,
  "peer-message": parsePeerMessage,
} as const;

describe("fixtures", () => {
  for (const [name, parse] of Object.entries(parsers)) {
    it(`${name}: every valid fixture parses (object and string form) and round-trips`, () => {
      for (const f of load("valid", name)) {
        const parsed = parse(f);
        expect(parsed, JSON.stringify(f)).not.toBeNull();
        expect(parse(JSON.stringify(f))).toEqual(parsed);
        expect(parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
      }
    });
    it(`${name}: every invalid fixture is rejected`, () => {
      for (const f of load("invalid", name)) expect(parse(f), JSON.stringify(f)).toBeNull();
    });
  }

  it("rejects malformed JSON strings without throwing", () => {
    expect(parseClientMessage("{not json")).toBeNull();
    expect(parseServerMessage("x".repeat(70_000))).toBeNull();
  });
});

describe("ids and links", () => {
  it("base64url round-trips arbitrary bytes", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(37));
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });

  it("generates valid peer ids and secrets", () => {
    expect(isValidPeerId(generatePeerId())).toBe(true);
    expect(parseCallLink(generateSecret())).not.toBeNull();
  });

  it("builds and parses call links", () => {
    const s = generateSecret();
    const link = buildCallLink("https://clearcall.example/", s);
    expect(link).toBe(`https://clearcall.example/c#${s}`);
    expect(parseCallLink(link)).toBe(s);
    expect(parseCallLink(`/c#${s}`)).toBe(s);
    expect(parseCallLink("https://clearcall.example/c#short")).toBeNull();
    expect(parseCallLink("https://clearcall.example/")).toBeNull();
  });
});

describe("room keys and signal encryption", () => {
  it("derives a stable, valid room id that differs per secret", async () => {
    const s = generateSecret();
    const a = await deriveRoomKeys(s);
    const b = await deriveRoomKeys(s);
    expect(isValidRoomId(a.roomId)).toBe(true);
    expect(a.roomId).toBe(b.roomId);
    expect((await deriveRoomKeys(generateSecret())).roomId).not.toBe(a.roomId);
    expect(a.roomId).not.toContain(s.slice(0, 10));
  });

  it("encrypts so only the addressed recipient in the same room can decrypt", async () => {
    const s = generateSecret();
    const alice = await deriveRoomKeys(s);
    const bob = await deriveRoomKeys(s);
    const [A, B, C] = [generatePeerId(), generatePeerId(), generatePeerId()];
    const payload = { k: "hello", name: "Ravi" } as const;
    const blob = await encryptSignal(alice, A, B, payload);

    expect(await decryptSignal(bob, A, B, blob)).toEqual(payload);
    // Server can't redirect to another peer or spoof the sender.
    expect(await decryptSignal(bob, A, C, blob)).toBeNull();
    expect(await decryptSignal(bob, C, B, blob)).toBeNull();
    // Other rooms can't read it.
    expect(await decryptSignal(await deriveRoomKeys(generateSecret()), A, B, blob)).toBeNull();
    // Tampering is detected.
    const tampered = `${blob.slice(0, -2)}${blob.endsWith("A") ? "B" : "A"}A`;
    expect(await decryptSignal(bob, A, B, tampered)).toBeNull();
    expect(await decryptSignal(bob, A, B, "garbage")).toBeNull();
  });

  it("uses a fresh IV per message", async () => {
    const keys = await deriveRoomKeys(generateSecret());
    const [A, B] = [generatePeerId(), generatePeerId()];
    const p = { k: "ice", candidate: null } as const;
    expect(await encryptSignal(keys, A, B, p)).not.toBe(await encryptSignal(keys, A, B, p));
  });
});
