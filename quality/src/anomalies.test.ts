import { describe, expect, it } from "vitest";
import {
  countTelemetry,
  type DiagInput,
  findAnomalies,
  loggedPolicyKbps,
  longestRun,
  type PeerEvidence,
  parseFault,
  policyTargetKbps,
} from "./anomalies.ts";
import { renderDiagSummary } from "./diag-report.ts";
import { synthTimeline } from "./fixtures.ts";

const t0 = 1_700_000_000_000;
const TEL = "[client abc123] info peer connected {}\n[stats abc123] out=900 in=880\n";

function peer(over: Partial<PeerEvidence> = {}): PeerEvidence {
  return {
    label: "p0",
    connectedMs: 900,
    firstFrameMs: 1100,
    timeline: synthTimeline({ t0, seconds: 30, sendKbps: () => 1400, peers: ["peerB"] }),
    logs: [],
    pageErrors: [],
    consoleErrors: [],
    crashed: false,
    hasQaHook: true,
    ...over,
  };
}
const input = (peers: PeerEvidence[], over: Partial<DiagInput> = {}): DiagInput => ({
  participants: 2,
  peers,
  workerLog: TEL,
  faults: [],
  t0,
  ...over,
});
const rules = (a: ReturnType<typeof findAnomalies>) => a.map((x) => `${x.severity}:${x.rule}`);

describe("parseFault", () => {
  it("parses fault specs", () => {
    expect(parseFault("drop-signaling@20s")).toEqual({ fault: "drop-signaling", atS: 20, peer: 0 });
    expect(parseFault("restart-ice@15:p1")).toEqual({ fault: "restart-ice", atS: 15, peer: 1 });
    expect(parseFault("kill-peer@2.5s:3")).toEqual({ fault: "kill-peer", atS: 2.5, peer: 3 });
    expect(() => parseFault("explode@1s")).toThrow(/bad --fault/);
  });
});

describe("helpers", () => {
  it("policy targets follow ADR-0005", () => {
    expect([2, 3, 4, 5, 10].map(policyTargetKbps)).toEqual([1500, 600, 600, 150, 150]);
  });
  it("reads the latest logged policy bitrate", () => {
    expect(loggedPolicyKbps([])).toBeNull();
    expect(
      loggedPolicyKbps([
        { t: 1, level: "info", scope: "policy", msg: "apply", data: { maxBitrate: 1_500_000 } },
        { t: 2, level: "info", scope: "peer", msg: "x", data: { maxBitrate: 1 } },
        { t: 3, level: "info", scope: "policy", msg: "apply", data: { video: { maxBitrate: 600_000 } } },
      ]),
    ).toBe(600);
  });
  it("counts telemetry lines", () => expect(countTelemetry(TEL + TEL)).toEqual({ client: 2, stats: 2 }));
  it("measures the longest run", () => {
    const tl = synthTimeline({ t0, seconds: 30, sendKbps: (t) => (t >= 5 && t < 17 ? 100 : 1000) });
    expect(longestRun(tl, (s) => (s.local.outboundKbps ?? 0) < 500)).toBe(12);
    expect(longestRun(tl, () => false)).toBe(0);
  });
});

describe("findAnomalies", () => {
  it("a healthy run has no anomalies", () => {
    expect(findAnomalies(input([peer(), peer({ label: "p1" })]))).toEqual([]);
  });

  it("flags missing telemetry as hard (plan decision)", () => {
    expect(rules(findAnomalies(input([peer()], { workerLog: "[stats x]" })))).toEqual(["hard:no-telemetry"]);
    expect(rules(findAnomalies(input([peer()], { workerLog: "" })))).toEqual(["hard:no-telemetry"]);
  });

  it("flags never-connected, crashes, page errors, missing hook and empty stats as hard", () => {
    const a = findAnomalies(
      input([
        peer({
          connectedMs: null,
          crashed: true,
          pageErrors: ["TypeError: x"],
          hasQaHook: false,
          timeline: [],
        }),
      ]),
    );
    expect(rules(a)).toEqual([
      "hard:crashed",
      "hard:no-qa-hook",
      "hard:never-connected",
      "hard:page-error",
      "hard:no-stats",
    ]);
  });

  it("error logs are hard unless a fault was injected", () => {
    const logs = [{ t: t0 + 5, level: "error" as const, scope: "signaling", msg: "socket closed" }];
    expect(rules(findAnomalies(input([peer({ logs })])))).toEqual(["hard:error-log"]);
    const f = findAnomalies(input([peer({ logs })], { faults: [parseFault("drop-signaling@5s")] }));
    expect(rules(f)).toEqual(["soft:error-log"]);
    expect(f[0]?.detail).toContain("signaling");
    // Errors before the window are ignored.
    expect(findAnomalies(input([peer({ logs: [{ ...logs[0]!, t: t0 - 1 }] })]))).toEqual([]);
  });

  it("soft quality smells: freezes, concealment, low bitrate, encode time, long tasks, slow connect", () => {
    const tl = synthTimeline({
      t0,
      seconds: 40,
      freezeS: (t) => t * 0.05,
      concealed: (t) => t * 48000 * 0.05,
      sendKbps: () => 300, // per-connection 300 < 750 (50 % of 1500) for the whole run
      encodeMs: () => 25,
      longTaskMs: () => 300,
    });
    const a = findAnomalies(input([peer({ timeline: tl, connectedMs: 12_000, firstFrameMs: 6_000 })]));
    expect(rules(a)).toEqual([
      "soft:slow-connect",
      "soft:slow-first-frame",
      "soft:freezes",
      "soft:audio-concealment",
      "soft:low-bitrate",
      "soft:slow-encode",
      "soft:long-tasks",
    ]);
  });

  it("uses the logged policy target instead of the table", () => {
    const tl = synthTimeline({ t0, seconds: 30, sendKbps: () => 300 });
    const logs = [
      { t: t0, level: "info" as const, scope: "policy", msg: "apply", data: { maxBitrate: 500_000 } },
    ];
    expect(findAnomalies(input([peer({ timeline: tl, logs })]))).toEqual([]);
  });

  it("flags peers not connected at the end", () => {
    const tl = synthTimeline({ t0, seconds: 20, connection: (t) => (t > 15 ? "failed" : "connected") });
    expect(rules(findAnomalies(input([peer({ timeline: tl })])))).toContain("hard:not-connected-at-end");
  });
});

describe("diag summary", () => {
  it("renders anomalies and a per-peer table", () => {
    const inp = input([peer({ pageErrors: ["start failed: locator.click: Timeout"] })], { workerLog: "" });
    const a = findAnomalies(inp);
    expect(rules(a)).toEqual(["hard:no-telemetry", "hard:setup-failed"]);
    const md = renderDiagSummary(inp, a, {
      started: "s",
      finished: "f",
      url: "http://localhost:8787",
      durationS: 30,
      shaping: "unshaped (local)",
      faults: [parseFault("drop-signaling@10s")],
      cpu: { p0: 42 },
      dir: "/tmp/x",
    });
    expect(md).toContain("**2 HARD anomalies**");
    expect(md).toContain("drop-signaling@10s by p0");
    expect(md).toMatch(/\| p0 \| 900 \| 1100 \| 1400\/1400 \|/);
    expect(md).toContain("| 42 | host |");
  });
});
