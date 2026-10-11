import { env } from "cloudflare:workers";
import { DEV_LOG_MAX_BYTES } from "@clearcall/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compact, formatBatch } from "../src/dev.ts";
import handler from "../src/index.ts";
import { worker } from "./helpers.ts";

const PEER = "AbCdEfGhIjKlMnOp";

const batch = {
  peer: PEER,
  entries: [
    { t: 1, level: "info", scope: "sig", msg: "connected", data: { attempt: 2 } },
    { t: 2, level: "warn", scope: "pc", msg: "ice restart" },
  ],
  samples: [{ t: 3, peers: [{ id: "x", name: "Alice", kbpsOut: 512 }] }],
};

function post(body: string | object, init: RequestInit = {}) {
  return worker.fetch("http://localhost/api/dev/log", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

/** The Worker with DEV_TELEMETRY="0" (as in staging/production). */
const fetchWith = handler.fetch as unknown as (req: Request, env: unknown) => Promise<Response>;
const disabled = (path: string, init?: RequestInit) =>
  fetchWith(new Request(`http://localhost${path}`, init), { ...env, DEV_TELEMETRY: "0" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dev telemetry enabled (DEV_TELEMETRY=1, local default)", () => {
  it("GET /api/dev/config → {telemetry:true}", async () => {
    const res = await worker.fetch("http://localhost/api/dev/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telemetry: true });
  });

  it("POST /api/dev/log prints one line per entry and per sample → 204", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => {
      lines.push(String(l));
    });
    const res = await post(batch);
    expect(res.status).toBe(204);
    expect(lines).toEqual([
      '[client AbCdEf] info sig connected {"attempt":2}',
      "[client AbCdEf] warn pc ice restart",
      '[stats AbCdEf] {"t":3,"peers":[{"id":"x","name":"[redacted]","kbpsOut":512}]}',
    ]);
  });

  it("invalid batch → 400", async () => {
    for (const body of ["nope", "{}", JSON.stringify({ peer: PEER, entries: [{ level: "loud" }] })]) {
      expect((await post(body)).status, body).toBe(400);
    }
  });

  it("> DEV_LOG_MAX_BYTES → 413", async () => {
    const big = {
      peer: PEER,
      entries: [{ t: 1, level: "info", scope: "s", msg: "x".repeat(DEV_LOG_MAX_BYTES) }],
    };
    expect((await post(big)).status).toBe(413);
  });

  it("wrong methods → 405", async () => {
    expect((await worker.fetch("http://localhost/api/dev/log")).status).toBe(405);
    expect((await worker.fetch("http://localhost/api/dev/config", { method: "POST" })).status).toBe(405);
  });

  it("unknown /api/dev path → 404", async () => {
    expect((await worker.fetch("http://localhost/api/dev/other")).status).toBe(404);
  });
});

describe("dev telemetry disabled (DEV_TELEMETRY=0, staging/production)", () => {
  it("both endpoints → 404 and nothing is printed", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await disabled("/api/dev/config")).status).toBe(404);
    expect((await disabled("/api/dev/log", { method: "POST", body: JSON.stringify(batch) })).status).toBe(
      404,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("health still works", async () => {
    expect((await disabled("/api/health")).status).toBe(200);
  });
});

describe("formatting", () => {
  it("lobby peers keep a distinguishable label", () => {
    expect(
      formatBatch({ peer: "lobby-k3j9x2", entries: [{ t: 0, level: "debug", scope: "m", msg: "hi" }] }),
    ).toEqual(["[client lobby-k3j9x2] debug m hi"]);
  });

  it("redacts names, SDP, blobs and credentials at any depth", () => {
    expect(
      compact({
        a: { name: "Bob", sdp: "v=0", data: "blob", credential: "c", username: "u", secret: "s" },
        ok: 1,
      }),
    ).toBe(
      '{"a":{"name":"[redacted]","sdp":"[redacted]","data":"[redacted]","credential":"[redacted]","username":"[redacted]","secret":"[redacted]"},"ok":1}',
    );
  });
});
