import { test as base, expect, type BrowserContext, type ConsoleMessage, type Request } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { BookingApp } from "../support/booking-app";
import { env } from "../support/env";
import { CURSOR_GLIDE_MS, installCursor } from "../support/cursor";

/**
 * Playwright fixtures only: the run's one Chrome window (sharedContext, with the test user's login) and the
 * per-test `app` page object. All common helper functions live in ./helper.ts.
 */

/** How this run's test user got in (signup mode only): "signup" = new user created, "login" = existing user. */
export const testUser: { email?: string; result?: "login" | "signup" } = {};

type Fixtures = {
  app: BookingApp;
};

type WorkerFixtures = {
  /**
   * One browser context (= one Chrome window) shared by every test in the run (workers=1), so a headed run
   * opens Chrome once and closes it once at the end, instead of a new window per test.
   */
  sharedContext: BrowserContext;
};

export const test = base.extend<Fixtures, WorkerFixtures>({
  sharedContext: [
    async ({ browser }, use, workerInfo) => {
      const projectUse = workerInfo.project.use;
      const signup = env.authMode === "signup";
      const context = await browser.newContext({
        baseURL: env.baseURL,
        // signup mode starts logged out; saved mode reuses the login from `npm run auth`
        storageState: signup ? undefined : env.storageState,
        timezoneId: env.browserTz,
        locale: "en-US",
        viewport: projectUse.viewport ?? { width: 1440, height: 900 },
        userAgent: projectUse.userAgent,
        deviceScaleFactor: projectUse.deviceScaleFactor,
      });
      // Visible cursor for every page in this window, before the first page opens (login included)
      if (env.showCursor) {
        await context.addInitScript(installCursor, { glideMs: CURSOR_GLIDE_MS, idleMs: env.readMs + 3000 });
      }
      context.setDefaultTimeout(projectUse.actionTimeout || 15_000);
      context.setDefaultNavigationTimeout(projectUse.navigationTimeout || 45_000);
      const page = await context.newPage();

      if (signup) {
        // One test user, reused across runs (its email is remembered in .auth/e2e-user.json):
        //  - remembered user exists      -> log in with email + code only
        //  - remembered user was deleted -> the popup shows the signup form -> sign the same email up again
        //  - remembered user is blocked, or none remembered yet -> sign up a brand-new teetime-e2e-<time> user
        const app = new BookingApp(page);
        const userFile = path.join(path.dirname(env.storageState), "e2e-user.json");
        const newEmail = () => {
          const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14); // yyyymmddhhmmss
          return `${env.signup.emailPrefix}-${stamp}@${env.signup.emailDomain}`.toLowerCase();
        };
        const login = (email: string) =>
          app.loginOrSignUp({
            email,
            firstName: env.signup.firstName,
            lastName: env.signup.lastName,
            phone: env.signup.phone,
            locationName: env.locationName,
            otp: env.testOtp,
          });

        // Reuse a saved login instead of the login popup: feature commands (npm run test:extend, …) reuse the last
        // saved one and open the calendar directly; npm test only reuses its own run's (a browser restarted after a
        // failed test). See reuseRunSession.
        const sessionFile = path.join(path.dirname(env.storageState), "run-session.json");
        const saved = readSavedTestUser(userFile);
        if (saved && (await reuseRunSession(app, context, sessionFile, saved))) {
          app.api.detach();
          testUser.email = saved;
          testUser.result = "login";
          console.log(`[teetime-e2e] reused the saved login for ${saved}: calendar opened directly, no login popup`);
          await use(context);
          await context.close();
          return;
        }

        let email = saved ?? newEmail();
        let result = await login(email);
        if (result === "blocked") {
          console.log(`[teetime-e2e] test user ${email} is blocked; creating a new one`);
          email = newEmail();
          result = await login(email);
          if (result === "blocked") throw new Error(`New test user ${email} is blocked too`);
        }
        app.api.detach();
        testUser.email = email;
        testUser.result = result;
        fs.mkdirSync(path.dirname(userFile), { recursive: true });
        fs.writeFileSync(userFile, JSON.stringify({ email, lastLogin: new Date().toISOString() }, null, 2));
        console.log(
          `[teetime-e2e] ${result === "login" ? "logged in existing" : "signed up new"} test user: ${email} ` +
            `(inbox: https://yopmail.com/?${email.split("@")[0]})`,
        );
        // Keep this run's login on disk for reference. A separate file, so the saved account from `npm run auth`
        // (TEETIME_STORAGE_STATE, used by TEETIME_AUTH_MODE=saved) is never overwritten.
        await context.storageState({ path: path.join(path.dirname(env.storageState), "last-signup-user.json") });
        // For browsers restarted later in this run (see reuseRunSession). .auth/ is git-ignored.
        const { cookies } = await context.storageState();
        fs.writeFileSync(sessionFile, JSON.stringify({ runId: process.env.TEETIME_RUN_ID, email, cookies }));
      }

      await use(context);
      await context.close();
    },
    { scope: "worker", timeout: 120_000 },
  ],

  // Every test uses the same page of the shared context. After each test: remove its route mocks/guards
  // and close any extra tabs it opened, so the next test starts clean in the same window.
  page: async ({ sharedContext }, use) => {
    const page = sharedContext.pages()[0] ?? (await sharedContext.newPage());
    await use(page);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    for (const p of sharedContext.pages()) if (p !== page) await p.close();
  },

  app: async ({ page }, use, testInfo) => {
    const app = new BookingApp(page);
    // Keep useful browser-side errors in the report.
    const logs: string[] = [];
    const onConsole = (m: ConsoleMessage) => {
      if (m.type() === "error") logs.push(`[console.error] ${m.text()}`);
    };
    const onPageError = (e: Error) => logs.push(`[pageerror] ${e.message}`);
    const onRequestFailed = (r: Request) => {
      if (r.url().startsWith(env.apiURL)) logs.push(`[requestfailed] ${r.method()} ${r.url()} ${r.failure()?.errorText}`);
    };
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("requestfailed", onRequestFailed);
    await use(app);
    // The page is shared across tests: detach this test's listeners so they don't pile up.
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed);
    app.api.detach();
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("failure.png", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      if (logs.length) await testInfo.attach("browser-errors.txt", { body: logs.join("\n"), contentType: "text/plain" });
    }
  },
});

export { expect };

/** Email of the test user remembered from an earlier run, if it is still a valid test address. */
function readSavedTestUser(file: string): string | null {
  try {
    const email = String(JSON.parse(fs.readFileSync(file, "utf8")).email ?? "").toLowerCase();
    // Only reuse our own test addresses (the dev backend's fixed code only applies to them).
    return email.startsWith(`${env.signup.emailPrefix}-`) && email.includes("@") ? email : null;
  } catch {
    return null; // no file yet (first run) or unreadable -> sign up a new user
  }
}

/**
 * Reuse a saved login (only for the same test user): put its cookies in the new browser and open /book-now. True
 * when the calendar loads signed in; otherwise the cookies are removed and the caller logs in with the email code.
 *  - npm test (TEETIME_FRESH_LOGIN): logs in fresh once; afterwards only that run's session is reused
 *  - every other command: the last saved session from any run (the app's login lasts 180 days)
 */
async function reuseRunSession(app: BookingApp, context: BrowserContext, file: string, email: string): Promise<boolean> {
  try {
    if (!fs.existsSync(file)) return false;
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s.email !== email) return false;
    const sameRun = !!process.env.TEETIME_RUN_ID && s.runId === process.env.TEETIME_RUN_ID;
    if (process.env.TEETIME_FRESH_LOGIN === "1" && !sameRun) return false;
    await context.addCookies(s.cookies);
    await app.open(); // throws when the login popup shows (session no longer valid)
    return true;
  } catch {
    await context.clearCookies();
    return false;
  }
}
