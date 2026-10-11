import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.CLEARCALL_URL ?? "http://localhost:8787";
const chromiumMedia = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];

// The app is served by `make dev` (scripts/e2e.sh starts it). Each participant = its own browser context.
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
      testIgnore: /screens\//,
      use: { ...devices["Desktop Chrome"], launchOptions: { args: chromiumMedia } },
    },
    {
      name: "firefox",
      testIgnore: /screens\//,
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
    { name: "webkit", testIgnore: /screens\//, use: { ...devices["Desktop Safari"] } },
    {
      // Screenshot suite (make screenshots): FakeCallController scenarios at phone + desktop sizes.
      name: "screens",
      testMatch: /screens\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], launchOptions: { args: chromiumMedia } },
    },
  ],
});
