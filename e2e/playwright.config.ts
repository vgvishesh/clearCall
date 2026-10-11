import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.CLEARCALL_URL ?? "http://localhost:8787";
const chromiumMedia = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];

/** Heavy specs (10-party mesh, room-full): only ever run in the `capacity` project, alone, after everything else. */
const CAPACITY = /call-large\.spec\.ts/;

// The app is served by `make dev` (scripts/e2e.sh starts it). Each participant = its own browser context.
//
// Capacity isolation: the `capacity` project is the `teardown` of chromium/firefox/webkit, so Playwright starts it
// only after those projects have finished (pass or fail) and runs it with one worker. A 10-party mesh never shares the
// CPU with other tests. Consequences:
//   - `--project=chromium` (any filter) also runs `capacity` at the end; add `--no-deps` to skip it while iterating.
//   - `--project=capacity` runs only the capacity specs.
export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: [["line"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    permissions: ["camera", "microphone"],
  },
  projects: [
    {
      name: "chromium",
      testIgnore: [/screens\//, CAPACITY],
      teardown: "capacity",
      use: { ...devices["Desktop Chrome"], launchOptions: { args: chromiumMedia } },
    },
    {
      name: "firefox",
      testIgnore: [/screens\//, CAPACITY],
      teardown: "capacity",
      use: {
        ...devices["Desktop Firefox"],
        permissions: [],
        launchOptions: {
          firefoxUserPrefs: {
            "media.navigator.streams.fake": true,
            "media.navigator.permission.disabled": true,
          },
        },
      },
    },
    {
      name: "webkit",
      testIgnore: [/screens\//, CAPACITY],
      teardown: "capacity",
      use: { ...devices["Desktop Safari"] },
    },
    {
      // 10-party mesh + room-full: one Chromium, one context per participant, one worker, never alongside other specs.
      name: "capacity",
      testMatch: CAPACITY,
      workers: 1,
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"], launchOptions: { args: chromiumMedia } },
    },
    {
      // Screenshot suite (make screenshots): FakeCallController scenarios at phone + desktop sizes.
      name: "screens",
      testMatch: /screens\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], launchOptions: { args: chromiumMedia } },
    },
  ],
});
