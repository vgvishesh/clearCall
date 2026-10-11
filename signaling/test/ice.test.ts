import { parseServerMessage } from "@clearcall/protocol";
import { describe, expect, it } from "vitest";
import {
  type CachedIce,
  type IceDeps,
  resolveIceServers,
  STUN_SERVER,
  TURN_CACHE_MS,
  TURN_TTL_SECONDS,
  turnEndpoint,
} from "../src/ice.ts";

const CF_RESPONSE = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "user-x",
      credential: "cred-y",
    },
  ],
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function harness(opts: { response?: () => Response | Promise<Response>; limiterOk?: boolean[] } = {}) {
  const calls: Call[] = [];
  let store: CachedIce | undefined;
  const limiterOk = [...(opts.limiterOk ?? [])];
  const deps = (now: number, extra: Partial<IceDeps> = {}): IceDeps => ({
    keyId: "key-id",
    apiToken: "api-token",
    limiter: {
      limit: async () => ({ success: limiterOk.length ? limiterOk.shift()! : true }),
    },
    cache: { get: () => store, put: (v) => (store = v) },
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return opts.response ? opts.response() : Response.json(CF_RESPONSE, { status: 201 });
    }) as typeof fetch,
    now,
    ...extra,
  });
  return { calls, deps, cache: () => store };
}

describe("resolveIceServers", () => {
  it("without secrets → STUN only, no fetch", async () => {
    const h = harness();
    const r = await resolveIceServers(h.deps(0, { keyId: undefined, apiToken: undefined }), "1.2.3.4");
    expect(r).toEqual({ iceServers: [STUN_SERVER], outcome: "stun-only" });
    expect(h.calls).toHaveLength(0);
  });

  it("mints via generate-ice-servers with bearer token and 12 h TTL; strips port 53 and duplicates STUN", async () => {
    const h = harness();
    const r = await resolveIceServers(h.deps(0), "1.2.3.4");
    expect(r.outcome).toBe("minted");
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.url).toBe(turnEndpoint("key-id"));
    expect(call.url).toBe(
      "https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers",
    );
    expect(call.init?.method).toBe("POST");
    expect(new Headers(call.init?.headers).get("Authorization")).toBe("Bearer api-token");
    expect(JSON.parse(call.init?.body as string)).toEqual({ ttl: TURN_TTL_SECONDS });
    expect(r.iceServers).toEqual([
      STUN_SERVER,
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turn:turn.cloudflare.com:3478?transport=tcp",
          "turns:turn.cloudflare.com:5349?transport=tcp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "user-x",
        credential: "cred-y",
      },
    ]);
    // the result is a valid welcome.iceServers
    const welcome = { t: "welcome", v: 1, peerId: "AAAAAAAAAAAAAAAA", peers: [], iceServers: r.iceServers };
    expect(parseServerMessage(JSON.stringify(welcome))).not.toBeNull();
  });

  it("caches per room for TURN_CACHE_MS, then re-mints", async () => {
    const h = harness();
    await resolveIceServers(h.deps(0), "1.1.1.1");
    expect((await resolveIceServers(h.deps(TURN_CACHE_MS - 1), "2.2.2.2")).outcome).toBe("cached");
    expect(h.calls).toHaveLength(1);
    expect((await resolveIceServers(h.deps(TURN_CACHE_MS), "2.2.2.2")).outcome).toBe("minted");
    expect(h.calls).toHaveLength(2);
    expect(h.cache()?.expiresAt).toBe(TURN_CACHE_MS * 2);
  });

  it("per-IP limiter rejects → STUN only, nothing minted or cached", async () => {
    const h = harness({ limiterOk: [false] });
    expect(await resolveIceServers(h.deps(0), "6.6.6.6")).toEqual({
      iceServers: [STUN_SERVER],
      outcome: "ip-limited",
    });
    expect(h.calls).toHaveLength(0);
    expect(h.cache()).toBeUndefined();
  });

  it("a cache hit does not consume the per-IP limit", async () => {
    let limits = 0;
    const h = harness();
    const counting = (now: number) =>
      h.deps(now, {
        limiter: {
          limit: async () => {
            limits++;
            return { success: true };
          },
        },
      });
    await resolveIceServers(counting(0), "1.1.1.1");
    await resolveIceServers(counting(1), "1.1.1.1");
    expect(limits).toBe(1);
  });

  it.each([
    ["HTTP error", () => new Response("nope", { status: 401 })],
    ["bad JSON", () => new Response("not json", { status: 201 })],
    ["no TURN entries", () => Response.json({ iceServers: [{ urls: ["stun:x:3478"] }] }, { status: 201 })],
    ["missing credential", () => Response.json({ iceServers: [{ urls: ["turn:x:3478"], username: "u" }] })],
    [
      "network error",
      () => {
        throw new Error("boom");
      },
    ],
  ])("mint failure (%s) → STUN only, not cached", async (_name, response) => {
    const h = harness({ response });
    expect(await resolveIceServers(h.deps(0), "1.2.3.4")).toEqual({
      iceServers: [STUN_SERVER],
      outcome: "mint-failed",
    });
    expect(h.cache()).toBeUndefined();
  });

  it("accepts the legacy single-object iceServers shape", async () => {
    const h = harness({
      response: () =>
        Response.json(
          { iceServers: { urls: ["turn:t:3478"], username: "u", credential: "c" } },
          { status: 201 },
        ),
    });
    const r = await resolveIceServers(h.deps(0), "1.2.3.4");
    expect(r.iceServers).toEqual([STUN_SERVER, { urls: ["turn:t:3478"], username: "u", credential: "c" }]);
  });

  it("a throwing limiter does not block minting", async () => {
    const h = harness();
    const r = await resolveIceServers(
      h.deps(0, {
        limiter: {
          limit: async () => {
            throw new Error("down");
          },
        },
      }),
      "1.2.3.4",
    );
    expect(r.outcome).toBe("minted");
  });
});
