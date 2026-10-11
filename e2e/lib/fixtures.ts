/**
 * `test` with a `call` fixture: creates participants (one context each, optionally one browser each),
 * always attaches every participant's console/page errors/failed requests + QA logs/timeline, and closes them.
 *
 *   import { expect, test } from "../lib/fixtures.ts";
 *   test("two-party call", async ({ call }) => {
 *     const [a, b] = await call.participants("Alice", "Bob");
 *     await setupCall([a, b]);
 *   });
 */
import { type Browser, test as base, type LaunchOptions } from "@playwright/test";
import { closeParticipant, type NewParticipantOptions, newParticipant, type Participant } from "./call.ts";

export interface CallFixture {
  /** New participant in a fresh context of the shared test browser (or of `opts.browser`). */
  participant(
    name: string,
    opts?: Omit<NewParticipantOptions, "ownBrowser"> & { browser?: Browser },
  ): Promise<Participant>;
  /** Several participants in the shared browser. */
  participants(...names: string[]): Promise<Participant[]>;
  /**
   * New participant in its own browser instance (same project launch options). Prefer `participants()`: on a laptop
   * host, one browser per peer for a 10-party mesh thermally throttles; one browser with N contexts does not.
   */
  isolatedParticipant(name: string, opts?: Omit<NewParticipantOptions, "ownBrowser">): Promise<Participant>;
  /**
   * Launch an extra browser with custom args (e.g. without fake-UI flags) and optional extra launch options
   * (e.g. `channel: "chromium"`); closed at teardown.
   */
  launchBrowser(args?: string[], options?: LaunchOptions): Promise<Browser>;
  readonly all: readonly Participant[];
}

export const test = base.extend<{ call: CallFixture }>({
  call: async ({ browser, playwright, browserName, launchOptions }, use, testInfo) => {
    const browserType = playwright[browserName];
    const all: Participant[] = [];
    const extraBrowsers: Browser[] = [];
    let sharedBrowserUsed = false;
    const fixture: CallFixture = {
      all,
      async participant(name, opts = {}) {
        // WebKit lets only one page per browser capture at a time: when a second context starts getUserMedia, the
        // first context's camera+mic tracks go `muted` (no frames, no audio sent). So every WebKit participant after
        // the first gets its own browser instance.
        if (!opts.browser && browserName === "webkit" && sharedBrowserUsed) {
          return fixture.isolatedParticipant(name, opts);
        }
        if (!opts.browser) sharedBrowserUsed = true;
        const p = await newParticipant(opts.browser ?? browser, name, opts);
        all.push(p);
        return p;
      },
      async participants(...names) {
        const out: Participant[] = [];
        for (const n of names) out.push(await fixture.participant(n));
        return out;
      },
      async isolatedParticipant(name, opts = {}) {
        const b = await browserType.launch(launchOptions);
        const p = await newParticipant(b, name, { ...opts, ownBrowser: true });
        all.push(p);
        return p;
      },
      async launchBrowser(args, options) {
        const b = await browserType.launch({ ...launchOptions, ...(args ? { args } : {}), ...options });
        extraBrowsers.push(b);
        return b;
      },
    };
    await use(fixture);
    // Evidence first (pages still open), then teardown.
    await Promise.all(all.map((p) => p.diag.attach(testInfo, p.page).catch(() => {})));
    await Promise.all(all.map(closeParticipant));
    await Promise.all(extraBrowsers.map((b) => b.close().catch(() => {})));
  },
});

export { expect } from "@playwright/test";
