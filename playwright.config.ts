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
// `npm test` (= tests/main.spec.ts, all steps; TC1 of its card flow is the login step) and `npm run test:flow`
// (--grep @card-flow) always log in fresh. The other step commands (npm run test:wallet, … = one step picked with
// --grep) and test:one (-g) reuse the login saved by an earlier run and open the calendar directly.
const picksSteps = process.argv.some((a) => a === "--grep" || a === "-g" || a.startsWith("--grep="));
const isMainRun =
  process.argv.some((a) => a.includes("@card-flow")) || (process.argv.some((a) => a.includes("main.spec")) && !picksSteps);
if (isMainRun) process.env.TEETIME_FRESH_LOGIN ??= "1";
// A run without a window (no --headed, --debug or --ui: e.g. CI) has nobody watching: it is a fast run by itself
// (support/env.ts: no reading pauses, cursor or YopMail window). Decided once, in the main process.
const watched = process.argv.some((a) => a === "--headed" || a === "--debug" || a === "--ui" || a.startsWith("--ui-")) || !!process.env.PWDEBUG;
process.env.TEETIME_WATCHED ??= watched ? "1" : "0";
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
            // Full screen: the window opens maximized and the page uses the whole window (desktop screens are
            // >= 768px wide -> desktop booking Dialog). viewport null needs deviceScaleFactor / isMobile unset.
            viewport: null,
            deviceScaleFactor: undefined,
            isMobile: undefined,
            launchOptions: { args: ["--start-maximized"] },
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
