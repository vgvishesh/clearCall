import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import handler from "../src/index.ts";

const fetchWith = handler.fetch as unknown as (req: Request, env: unknown) => Promise<Response>;
const health = (e: unknown) => fetchWith(new Request("http://localhost/api/health"), e).then((r) => r.json());

describe("/api/health", () => {
  it("reports turn:false without TURN secrets (STUN-only deployment)", async () => {
    const noTurn = { ...env, TURN_KEY_ID: undefined, TURN_KEY_API_TOKEN: undefined }; // ignore any local .dev.vars
    expect(await health(noTurn)).toEqual({ ok: true, turn: false });
  });

  it("reports turn:true only when both secrets are set, never their values", async () => {
    expect(await health({ ...env, TURN_KEY_ID: "k" })).toEqual({ ok: true, turn: false });
    const body = await health({ ...env, TURN_KEY_ID: "kid-123", TURN_KEY_API_TOKEN: "tok-456" });
    expect(body).toEqual({ ok: true, turn: true });
    expect(JSON.stringify(body)).not.toMatch(/kid-123|tok-456/);
  });
});
