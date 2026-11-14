import { test as base, expect, type BrowserContext, type ConsoleMessage, type Request, type TestInfo } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { BlockedError, BookingApp, annotateBlocked, type CreatedBooking, type SelectedBooking } from "../support/booking-app";
import { bookingCreationBlockedReason, env } from "../support/env";
import { CURSOR_GLIDE_MS, installCursor } from "../support/cursor";
import { addDays, isoDate } from "../support/time";

/** How this run's test user got in (signup mode only): "signup" = new user created, "login" = existing user. */
export const testUser: { email?: string; result?: "login" | "signup" } = {};

type Fixtures = {
  app: BookingApp;
  /** Bookings created by the current test; cancelled afterwards when TEETIME_CLEANUP=true. */
  created: CreatedBooking[];
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

        let email = readSavedTestUser(userFile) ?? newEmail();
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

  created: async ({ app }, use, testInfo) => {
    const created: CreatedBooking[] = [];
    await use(created);
    if (created.length) {
      await testInfo.attach("created-bookings.json", {
        body: JSON.stringify(created.map(({ bookingId, bayName, groupSize, date }) => ({ bookingId, bayName, groupSize, date })), null, 2),
        contentType: "application/json",
      });
    }
    if (env.cleanup) {
      for (const b of created) {
        const res = await app.cancelBooking(b.bookingId);
        testInfo.annotations.push({ type: "cleanup", description: `cancel ${b.bookingId}: HTTP ${res.status}` });
      }
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

/** Skip creation tests unless staging + explicit opt-in. */
export function requireBookingCreation() {
  const reason = bookingCreationBlockedReason();
  test.skip(!!reason, reason ?? "");
}

/** Converts a staging-data problem (no free slot, date not allowed, no saved card) into a reported BLOCKED skip. */
export async function orBlocked<T>(testInfo: TestInfo, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BlockedError) {
      annotateBlocked(testInfo, e.message);
      test.skip(true, e.message);
    }
    throw e;
  }
}

/** Steps 1–3: open site, select location, go to the booking date, pick a free bay, select the slot range. */
export async function selectRequestedSlot(
  app: BookingApp,
  testInfo: TestInfo,
  excludeBayIds: string[] = [],
  {
    reuseOpenPage = false,
    tryNextDays = 0,
    alsoFree,
  }: {
    reuseOpenPage?: boolean;
    /** No free bay on the date: click the calendar's next arrow and check up to this many following days. */
    tryNextDays?: number;
    /** The chosen bay must also be free for this slot range (see findAvailableBay). */
    alsoFree?: { startIdx: number; endIdx: number };
  } = {},
): Promise<SelectedBooking> {
  return orBlocked(testInfo, async () => {
    await test.step("Open booking site", async () => {
      // reuseOpenPage: stay on the calendar that is already open instead of reloading it
      if (reuseOpenPage) await app.openIfNeeded();
      else await app.open();
    });
    await test.step(`Select location "${env.locationName}"`, async () => {
      await app.selectLocation(env.locationName);
      await app.verifyLocationData(env.locationName);
    });
    let date = app.targetDate();
    await test.step(`Go to booking date (+${env.daysAhead} day)`, async () => {
      await app.goToDate(date);
    });
    return test.step(`Pick a bay free ${env.slotStart}–${env.slotEnd}`, async () => {
      for (let day = 0; ; day++) {
        try {
          const bay = await app.findAvailableBay(date, excludeBayIds, alsoFree);
          if (day > 0) testInfo.annotations.push({ type: "date", description: `moved ${day} day(s) ahead to ${isoDate(date)}` });
          const sel = await app.selectRange(bay, date);
          await app.verifySelectionHeader(sel);
          return sel;
        } catch (e) {
          if (!(e instanceof BlockedError) || day >= tryNextDays) throw e;
          // Time taken in every bay: next day via the calendar's › button (goToDate stops if the app blocks the date)
          console.log(`[teetime-e2e] ${env.slotStart}–${env.slotEnd} not free on ${isoDate(date)}; trying the next day`);
          date = addDays(date, 1);
          await app.goToDate(date);
        }
      }
    });
  });
}
