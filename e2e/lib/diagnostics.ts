/**
 * Per-participant evidence capture: console messages, page errors, failed requests (+ HTTP >= 400),
 * and — at teardown — the QA hook's structured logs and stats timeline. Everything is attached to the
 * Playwright test result so a failing multi-party test is debuggable from the report alone.
 */
import type { Page, TestInfo } from "@playwright/test";
import { hasQaHook, qaLogs, qaTimeline } from "./qa.ts";

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

  /** Attaches console/errors/requests and (best effort, bounded) QA logs + stats timeline. */
  async attach(testInfo: TestInfo, page: Page | undefined): Promise<void> {
    const safe = this.label.replace(/[^\w.-]+/g, "_");
    await testInfo.attach(`${safe}-console.txt`, {
      body: this.format() || "(no console output)",
      contentType: "text/plain",
    });
    if (!page || page.isClosed()) return;
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
      Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]).catch(
        () => undefined,
      );
    if (!(await withTimeout(hasQaHook(page), 2000))) return;
    const logs = await withTimeout(qaLogs(page), 3000);
    if (logs)
      await testInfo.attach(`${safe}-qa-logs.json`, {
        body: JSON.stringify(logs, null, 1),
        contentType: "application/json",
      });
    const timeline = await withTimeout(qaTimeline(page), 3000);
    if (timeline)
      await testInfo.attach(`${safe}-stats-timeline.json`, {
        body: JSON.stringify(timeline),
        contentType: "application/json",
      });
  }
}
