/**
 * Per-participant evidence capture: console messages, page errors, failed requests (+ HTTP >= 400),
 * and — at teardown — the QA hook's structured logs, stats snapshot and stats timeline. Everything is attached to the
 * Playwright test result so a failing multi-party test is debuggable from the report alone.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { hasQaHook, type LogEntry, qaLogs, qaStats, qaTimeline } from "./qa.ts";

export interface CapturedEvent {
  t: number;
  kind: "console" | "pageerror" | "requestfailed" | "http-error" | "crash" | "close";
  level?: string;
  text: string;
}

export class Diagnostics {
  readonly events: CapturedEvent[] = [];
  private readonly t0 = Date.now();

  constructor(readonly label: string) {}

  watch(page: Page): void {
    page.on("console", (m) => this.push({ kind: "console", level: m.type(), text: m.text() }));
    page.on("pageerror", (e) =>
      this.push({ kind: "pageerror", text: `${e.name}: ${e.message}\n${e.stack ?? ""}` }),
    );
    page.on("requestfailed", (r) =>
      this.push({
        kind: "requestfailed",
        text: `${r.method()} ${r.url()} — ${r.failure()?.errorText ?? "?"}`,
      }),
    );
    page.on("response", (r) => {
      if (r.status() >= 400)
        this.push({ kind: "http-error", text: `${r.status()} ${r.request().method()} ${r.url()}` });
    });
    page.on("crash", () => this.push({ kind: "crash", text: "page crashed" }));
  }

  push(e: Omit<CapturedEvent, "t">): void {
    this.events.push({ t: Date.now(), ...e });
  }

  get pageErrors(): CapturedEvent[] {
    return this.events.filter((e) => e.kind === "pageerror" || e.kind === "crash");
  }

  format(): string {
    return this.events
      .map((e) => {
        const ts = `+${((e.t - this.t0) / 1000).toFixed(3)}s`;
        return `${ts} ${e.kind}${e.level ? `:${e.level}` : ""} ${e.text}`;
      })
      .join("\n");
  }

  /**
   * Attaches console/errors/requests and (best effort, bounded) the QA hook's `logs()`, a final `stats()` snapshot
   * and `statsTimeline()`. When the test failed, every attachment is also written as a file into the test's output
   * dir (`e2e/test-results/<test>/`): `scripts/e2e.sh` runs the line reporter, which keeps no copy of body
   * attachments, so without files the engine logs of a failed run would be lost.
   */
  async attach(testInfo: TestInfo, page: Page | undefined): Promise<void> {
    const safe = this.label.replace(/[^\w.-]+/g, "_");
    const failed = testInfo.status !== testInfo.expectedStatus;
    const put = async (name: string, body: string, contentType: string) => {
      if (!failed) return testInfo.attach(name, { body, contentType });
      const path = testInfo.outputPath(name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      await testInfo.attach(name, { path, contentType });
    };
    await put(`${safe}-console.txt`, this.format() || "(no console output)", "text/plain");
    if (!page || page.isClosed()) return;
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
      Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]).catch(
        () => undefined,
      );
    if (!(await withTimeout(hasQaHook(page), 2000))) return;
    const logs = await withTimeout(qaLogs(page), 3000);
    if (logs) {
      await put(`${safe}-qa-logs.txt`, formatLogs(logs), "text/plain");
      await put(`${safe}-qa-logs.json`, JSON.stringify(logs, null, 1), "application/json");
    }
    const stats = await withTimeout(qaStats(page), 3000);
    if (stats) await put(`${safe}-stats.json`, JSON.stringify(stats, null, 1), "application/json");
    const timeline = await withTimeout(qaTimeline(page), 3000);
    if (timeline) await put(`${safe}-stats-timeline.json`, JSON.stringify(timeline), "application/json");
  }
}

/** One line per QA log entry (`HH:MM:SS.mmm level [scope] msg {data}`), readable without tooling. */
export function formatLogs(logs: readonly LogEntry[]): string {
  if (!logs.length) return "(no QA log entries)";
  return logs
    .map((e) => {
      const ts = new Date(e.t).toISOString().slice(11, 23);
      return `${ts} ${e.level.padEnd(5)} [${e.scope}] ${e.msg}${e.data ? ` ${JSON.stringify(e.data)}` : ""}`;
    })
    .join("\n");
}
