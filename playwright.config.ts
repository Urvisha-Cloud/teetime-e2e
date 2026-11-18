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
// One id per run (set in the main process; workers inherit it): a browser restarted after a failed test reuses the
// login made earlier in the SAME run instead of showing the login popup again (tests/fixtures.ts).
process.env.TEETIME_RUN_ID ??= String(Date.now());
const isAuthRun = process.env.TEETIME_AUTH_RUN === "1";

// Which browser runs the tests: by this computer — Windows / Linux: Google Chrome, macOS: Safari (WebKit) — or
// TEETIME_BROWSER in .env (chrome | safari | both). With --project=… on the command line (npm run test:chrome /
// test:safari) both are defined, so the one asked for always exists. Decided once in the main process (workers
// load this file again with another command line, but inherit env).
if (!process.env.TEETIME_BROWSERS) {
  const explicit = process.argv.some((a) => a.startsWith("--project"));
  const choice = (process.env.TEETIME_BROWSER || (process.platform === "darwin" ? "safari" : "chrome")).toLowerCase();
  process.env.TEETIME_BROWSERS = explicit || choice === "both" ? "chrome,safari" : choice === "safari" ? "safari" : "chrome";
}
const browsers = process.env.TEETIME_BROWSERS.split(",");

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
  // The browser(s) picked above (`browsers`): Google Chrome on Windows / Linux, Safari (WebKit) on macOS.
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
        {
          // Safari's engine (WebKit), same desktop window. Needs once: npx playwright install webkit
          name: "desktop-safari",
          testIgnore: [/auth\.setup\.ts/],
          use: {
            ...devices["Desktop Safari"],
            viewport: { width: 1440, height: 900 },
            storageState: env.storageState,
          },
        },
      ].filter((p) => browsers.includes(p.name === "desktop-safari" ? "safari" : "chrome")),
});
