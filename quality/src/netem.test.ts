import { describe, expect, it } from "vitest";
import {
  containerAppUrl,
  containerMediaPath,
  egressBypassSetup,
  egressNetem,
  forwarderCmd,
  gilbertParams,
  hostLoopbackPort,
  ingressNetem,
  ingressSetup,
  queueLimit,
  RUN_SERVER_CMD,
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

  it("keeps the Playwright control port out of the shaped band", () => {
    const [prio, filter] = egressBypassSetup(3000).map((c) => c.join(" "));
    expect(prio).toBe(
      `tc qdisc add dev eth0 root handle 1: prio bands 3 priomap ${Array(16).fill(2).join(" ")}`,
    );
    expect(filter).toBe(
      "tc filter add dev eth0 parent 1: protocol ip prio 1 u32 match ip sport 3000 0xffff flowid 1:1",
    );
    expect(egressNetem(loadProfile("4g_typical").link, "change", "eth0", true).join(" ")).toMatch(
      /^tc qdisc change dev eth0 parent 1:3 handle 30: netem delay 50ms/,
    );
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
    expect(containerAppUrl("http://localhost:8791/c?x")).toEqual({ url: "http://localhost:8791", args: [] });
    expect(containerAppUrl("http://127.0.0.1:8791").url).toBe("http://localhost:8791");
    expect(containerAppUrl("https://staging.example.com/x")).toEqual({
      url: "https://staging.example.com",
      args: [],
    });
    expect(hostLoopbackPort("http://localhost:8800")).toBe(8800);
    expect(hostLoopbackPort("https://staging.example.com")).toBeNull();
  });
  it("forwards the host app port inside the container and lets clients pass launch args", () => {
    const [bin, flag, js] = forwarderCmd(8800);
    expect([bin, flag]).toEqual(["node", "-e"]);
    expect(js).toContain('n.connect(8800,"host.docker.internal")');
    expect(js).toContain('.listen(8800,"127.0.0.1")');
    expect(RUN_SERVER_CMD).toContain("--unsafe");
  });
  it("maps cache media into /media", () => {
    expect(containerMediaPath(`${MEDIA_DIR}/talking_head.y4m`)).toBe("/media/talking_head.y4m");
    expect(() => containerMediaPath("/elsewhere/x.wav")).toThrow();
  });
});
