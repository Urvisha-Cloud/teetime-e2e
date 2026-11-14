import { defineConfig, devices } from "@playwright/test";
import { env, isNonProductionHost } from "./support/env";

// Dev/staging/local ONLY. Every run signs up test users (code 1111) and can book, so a production URL in .env
// stops the whole run here, before any browser opens — including `npm run auth`.
for (const [name, url] of [["TEETIME_BASE_URL", env.baseURL], ["TEETIME_API_URL", env.apiURL]] as const) {
  if (!isNonProductionHost(url)) {
    throw new Error(
      `[teetime-e2e] Refusing to run: ${name}=${url} is not a dev/staging/local address. ` +
        "These tests may only run against dev (e.g. https://dev-booking.teetimeindoorgolf.com).",
    );
  }
}

// `npm run auth` (= --project=setup) runs only the login step. Every other run checks the saved login
// invisibly in globalSetup, then opens Chrome once for all tests (shared window, see tests/fixtures.ts).
// Detected from the command line in the main process, then passed on through an environment variable:
// Playwright's worker processes load this config again with a different command line, but they inherit env.
if (process.argv.some((a) => a === "--project=setup" || a === "setup")) process.env.TEETIME_AUTH_RUN = "1";
const isAuthRun = process.env.TEETIME_AUTH_RUN === "1";

export default defineConfig({
  globalSetup: isAuthRun ? undefined : "./support/global-setup.ts",
  testDir: "./tests",
  // Booking tests share real staging inventory (bays/slots) -> run one at a time, never retry
  // automatically (a retry after a slow-but-successful POST would create a duplicate booking).
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["junit", { outputFile: "test-results/junit.xml" }],
  ],
  use: {
    baseURL: env.baseURL,
    timezoneId: env.browserTz,
    locale: "en-US",
    trace: "retain-on-failure",
    // Failure screenshots are attached by the `app` fixture (tests share one window, so per-test video is off).
    screenshot: "off",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  // channel "chrome" = the installed Google Chrome app (fresh profile each run), not Playwright's test browser.
  projects: isAuthRun
    ? [
        {
          name: "setup",
          testMatch: /auth\.setup\.ts/,
          timeout: 5 * 60_000, // allows a human to type the OTP in headed mode
          use: { ...devices["Desktop Chrome"], channel: "chrome" },
        },
      ]
    : [
        {
          name: "desktop-chromium",
          testIgnore: [/auth\.setup\.ts/],
          use: {
            ...devices["Desktop Chrome"],
            channel: "chrome",
            viewport: { width: 1440, height: 900 }, // >= 768px -> desktop booking Dialog
            storageState: env.storageState,
          },
        },
      ],
});
