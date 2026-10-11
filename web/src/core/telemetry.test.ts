import { parseDevLogBatch } from "@clearcall/protocol";
import { describe, expect, it, vi } from "vitest";
import { RemoteAudio } from "./audio-out.ts";
import { createLog } from "./log.ts";
import { createQaHook } from "./qa.ts";
import { startTelemetry, stripEntry, stripSample } from "./telemetry.ts";
import { advanceAndSettle, FakeClock, settle } from "./testing/fake-clock.ts";
import { FakeAudioEl } from "./testing/harness.ts";
import type { CallState, QaStatsSample } from "./types.ts";

const sample = (t: number): QaStatsSample => ({
  t,
  local: { outboundKbps: 10 },
  peers: [{ id: "p", name: "Alice", connectionState: "connected", audio: {}, video: {} }],
});

function mkFetch(config: { status: number; body?: unknown }) {
  const posts: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/dev/config"))
      return { ok: config.status === 200, json: async () => config.body } as unknown as Response;
    posts.push(String(init?.body));
    return { ok: true, status: 204 } as unknown as Response;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, posts };
}

describe("telemetry", () => {
  it("ships new entries and samples every 2 s, without names, in the protocol shape", async () => {
    const clock = new FakeClock();
    const log = createLog({ now: clock.now, consoleLevel: null });
    const samples: QaStatsSample[] = [];
    const { fetch, posts } = mkFetch({ status: 200, body: { telemetry: true } });
    const t = startTelemetry({ fetch, clock, log, peer: () => "lobby-x", samples: () => samples });
    await settle();
    expect(t.enabled).toBe(true);
    log.scope("peer").info("state", { peer: "abcdef", name: "Alice", nested: { name: "Bob", ok: 1 } });
    samples.push(sample(1));
    await advanceAndSettle(clock, 2000, 1000);
    expect(posts).toHaveLength(1);
    const batch = parseDevLogBatch(posts[0]!)!;
    expect(batch.peer).toBe("lobby-x");
    expect(batch.entries).toHaveLength(1);
    expect(batch.entries[0]!.data).toEqual({ peer: "abcdef", nested: { ok: 1 } });
    expect(posts[0]).not.toContain("Alice");
    expect(posts[0]).not.toContain("Bob");
    expect(batch.samples).toHaveLength(1);
    // nothing new → no post; new entry → only the new one
    await advanceAndSettle(clock, 2000, 1000);
    expect(posts).toHaveLength(1);
    log.scope("x").warn("second");
    await advanceAndSettle(clock, 2000, 1000);
    expect(parseDevLogBatch(posts[1]!)!.entries.map((e) => e.msg)).toEqual(["second"]);
    t.stop();
  });

  it("stays off when the Worker says 404, and uses sendBeacon on pagehide flush", async () => {
    const clock = new FakeClock();
    const log = createLog({ consoleLevel: null });
    const off = mkFetch({ status: 404 });
    const t1 = startTelemetry({ fetch: off.fetch, clock, log, peer: () => "p", samples: () => [] });
    await settle();
    log.scope("a").info("x");
    await advanceAndSettle(clock, 5000, 1000);
    expect(t1.enabled).toBe(false);
    expect(off.posts).toHaveLength(0);

    const on = mkFetch({ status: 200, body: { telemetry: true } });
    const beacon = vi.fn(() => true);
    const t2 = startTelemetry({
      fetch: on.fetch,
      sendBeacon: beacon,
      clock,
      log,
      peer: () => "p",
      samples: () => [],
    });
    await settle();
    await t2.flush(true);
    expect(beacon).toHaveBeenCalledWith("/api/dev/log", expect.stringContaining('"peer":"p"'));
  });

  it("strip helpers", () => {
    expect(stripEntry({ t: 1, level: "info", scope: "s", msg: "m" })).toEqual({
      t: 1,
      level: "info",
      scope: "s",
      msg: "m",
    });
    expect(JSON.stringify(stripSample(sample(1)))).not.toContain("Alice");
  });
});

describe("RemoteAudio", () => {
  it("one element per participant with a stream; removed when they leave", () => {
    const els: FakeAudioEl[] = [];
    const blocked: boolean[] = [];
    const ra = new RemoteAudio({
      createElement: () => {
        const e = new FakeAudioEl();
        els.push(e);
        return e;
      },
      onBlocked: (b) => blocked.push(b),
    });
    const s1 = {} as MediaStream;
    const s2 = {} as MediaStream;
    ra.sync([
      { id: "a", stream: s1 },
      { id: "b", stream: null },
    ]);
    expect(ra.size).toBe(1);
    expect(els[0]).toMatchObject({ srcObject: s1, autoplay: true, muted: false });
    ra.sync([{ id: "a", stream: s2 }]); // new stream object after a rebuilt pair → same element
    expect(els).toHaveLength(1);
    expect(els[0]!.srcObject).toBe(s2);
    ra.sync([]);
    expect(els[0]!.removed).toBe(true);
    expect(blocked).toEqual([]);
  });
});

describe("QA hook recording", () => {
  it("records a participant's stream with MediaRecorder and returns a Blob", async () => {
    class FakeRecorder {
      static isTypeSupported = (m: string) => m === "video/webm";
      state = "inactive";
      mimeType: string;
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(
        readonly stream: MediaStream,
        opts?: { mimeType?: string },
      ) {
        this.mimeType = opts?.mimeType ?? "";
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["abc"]) });
        this.onstop?.();
      }
    }
    const stream = {} as MediaStream;
    const state = { participants: [{ id: "p1", stream }] } as unknown as CallState;
    const hook = createQaHook({
      state: () => state,
      stats: async () => [],
      timeline: () => [],
      logs: () => [],
      transport: () => "mesh",
      dropSignaling: () => {},
      restartIce: () => {},
      killPeer: () => {},
      MediaRecorder: FakeRecorder as unknown as typeof MediaRecorder,
    });
    hook.startRecording("p1");
    const blob = await hook.stopRecording("p1");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob!.type).toBe("video/webm");
    expect(await hook.stopRecording("p1")).toBeNull();
    hook.startRecording("nobody");
    expect(await hook.stopRecording("nobody")).toBeNull();
  });
});
