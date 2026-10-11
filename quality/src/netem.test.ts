import { describe, expect, it } from "vitest";
import {
  containerAppUrl,
  containerMediaPath,
  egressNetem,
  gilbertParams,
  ingressNetem,
  ingressSetup,
  queueLimit,
} from "./netem.ts";
import { linkAt, loadProfile } from "./profiles.ts";
import { MEDIA_DIR } from "./util.ts";

describe("netem command builder", () => {
  it("random loss, delay with jitter, rate and queue", () => {
    const link = loadProfile("4g_typical").link;
    expect(egressNetem(link, "add").join(" ")).toBe(
      "tc qdisc add dev eth0 root netem delay 50ms 15ms distribution normal loss random 1% rate 3000kbit limit 63",
    );
    expect(ingressNetem(link, "change").join(" ")).toBe(
      "tc qdisc change dev ifb0 root netem rate 10000kbit limit 209",
    );
  });

  it("gilbert loss keeps the configured mean loss", () => {
    const { p, r } = gilbertParams(5);
    expect(p / (p + r)).toBeCloseTo(0.05);
    expect(r).toBe(0.5);
    const cmd = egressNetem(loadProfile("3g_lossy").link, "add").join(" ");
    expect(cmd).toContain("loss gemodel 2.6316% 50%");
    expect(cmd).toContain("rate 400kbit");
  });

  it("omits delay and loss when zero", () => {
    const cmd = egressNetem(
      { up_kbps: 1000, down_kbps: 1000, delay_ms: 0, jitter_ms: 0, loss_pct: 0, loss_model: "random" },
      "change",
    ).join(" ");
    expect(cmd).toBe("tc qdisc change dev eth0 root netem rate 1000kbit limit 50");
  });

  it("follows a schedule (bw_squeeze)", () => {
    const p = loadProfile("bw_squeeze");
    expect(egressNetem(linkAt(p, 31), "change").join(" ")).toContain("rate 250kbit");
    expect(egressNetem(linkAt(p, 61), "change").join(" ")).toContain("rate 2000kbit");
  });

  it("queue limit scales with rate", () => {
    expect(queueLimit(100)).toBe(50);
    expect(queueLimit(20_000)).toBe(417);
  });

  it("ingress setup redirects to ifb0 then shapes it", () => {
    const cmds = ingressSetup(loadProfile("good_wifi").link).map((c) => c.join(" "));
    expect(cmds[0]).toBe("ip link add ifb0 type ifb");
    expect(cmds.some((c) => c.includes("mirred egress redirect dev ifb0"))).toBe(true);
    expect(cmds.at(-1)).toContain("dev ifb0 root netem rate 50000kbit");
  });
});

describe("container addressing", () => {
  it("maps localhost to host.docker.internal and marks it secure", () => {
    expect(containerAppUrl("http://localhost:8791")).toEqual({
      url: "http://host.docker.internal:8791",
      args: ["--unsafely-treat-insecure-origin-as-secure=http://host.docker.internal:8791"],
    });
    expect(containerAppUrl("https://staging.example.com/x").args).toEqual([]);
  });
  it("maps cache media into /media", () => {
    expect(containerMediaPath(`${MEDIA_DIR}/talking_head.y4m`)).toBe("/media/talking_head.y4m");
    expect(() => containerMediaPath("/elsewhere/x.wav")).toThrow();
  });
});
