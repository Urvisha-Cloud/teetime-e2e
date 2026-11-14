import { chromium, type FullConfig } from "@playwright/test";
import * as fs from "fs";
import { env } from "./env";

/**
 * Runs once before the tests, without opening a visible window: checks that the saved login
 * (TEETIME_STORAGE_STATE, created by `npm run auth`) is still valid. The tests themselves then open
 * Chrome once and reuse that window for the whole run.
 */
export default async function globalSetup(_config: FullConfig) {
  // Signup mode logs in a brand-new user inside the shared test window (tests/fixtures.ts) — nothing to check here.
  if (env.authMode === "signup") {
    if (!/^\d{4}$/.test(env.testOtp)) {
      throw new Error("[teetime-e2e] TEETIME_AUTH_MODE=signup needs TEETIME_TEST_OTP = the dev backend's TEST_OTP (e.g. 1111).");
    }
    return;
  }
  const help = "Run `npm run auth` and type the 4-digit code from your email to log in again.";
  if (!fs.existsSync(env.storageState)) {
    throw new Error(`[teetime-e2e] No saved login at ${env.storageState}. ${help}`);
  }

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({ storageState: env.storageState, baseURL: env.baseURL });
    const page = await context.newPage();
    await page.goto("/book-now");
    const loggedIn = await page
      .locator('[data-slot="0"]')
      .first()
      .or(page.getByRole("heading", { name: "Select a Location" }))
      .or(page.locator("input#email"))
      .waitFor({ timeout: 45_000 })
      .then(async () => !(await page.locator("input#email").isVisible()))
      .catch(() => false);
    if (!loggedIn) throw new Error(`[teetime-e2e] The saved login has expired. ${help}`);
  } finally {
    await browser.close();
  }
}
