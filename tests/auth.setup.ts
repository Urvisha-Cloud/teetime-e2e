import { test as setup, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { env } from "../support/env";

/**
 * The app authenticates with email + 4-digit one-time code (LoginPopup: EmailStage -> OtpStage),
 * then stores the JWT in the `authToken` cookie (.teetimeindoorgolf.com) and redux-persist localStorage.
 * We save that browser state once and reuse it, so tests never handle passwords.
 *
 *  - Reuses TEETIME_STORAGE_STATE if it is still logged in.
 *  - Else, if TEETIME_TEST_OTP is set (staging test-OTP for the dedicated test account), logs in automatically.
 *  - Else, in headed mode (`npm run auth`), fills the email and waits for a human to type the code.
 */
setup("authenticate staging test account", async ({ page, browser }) => {
  const statePath = env.storageState;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  const loggedIn = page.locator('[data-slot="0"]').first().or(page.getByRole("heading", { name: "Select a Location" }));
  const emailInput = page.locator("input#email");

  if (fs.existsSync(statePath)) {
    const ctx = await browser.newContext({ storageState: statePath, baseURL: env.baseURL });
    const p = await ctx.newPage();
    await p.goto("/book-now");
    const ok = await p
      .locator('[data-slot="0"]')
      .first()
      .or(p.getByRole("heading", { name: "Select a Location" }))
      .or(p.locator("input#email"))
      .waitFor({ timeout: 45_000 })
      .then(async () => !(await p.locator("input#email").isVisible()))
      .catch(() => false);
    await ctx.close();
    if (ok) return; // stored session still valid
  }

  if (!env.testEmail) {
    throw new Error("No valid stored session. Set TEETIME_TEST_EMAIL (dedicated staging account) and run `npm run auth`.");
  }

  await page.goto("/book-now");
  await expect(emailInput.or(loggedIn)).toBeVisible({ timeout: 45_000 });
  if (await emailInput.isVisible()) {
    await emailInput.fill(env.testEmail);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Enter code to verify" })).toBeVisible({ timeout: 30_000 });

    if (env.testOtp) {
      const digits = env.testOtp.replace(/\D/g, "").split("");
      expect(digits, "TEETIME_TEST_OTP must be 4 digits").toHaveLength(4);
      for (let i = 0; i < 4; i++) await page.locator(`input[id="${i + 1}"]`).fill(digits[i]);
      await page.getByRole("button", { name: "Verify & Login" }).click();
    } else {
      // Manual step: a person types the code from the test inbox into the browser window.
      console.log(`\n[teetime-e2e] Enter the 4-digit code sent to ${env.testEmail} in the browser window (5 min).\n`);
    }
  }

  // New accounts are asked to complete a profile (ProfileStage) — finish it once by hand for the test account.
  await expect(loggedIn).toBeVisible({ timeout: env.testOtp ? 60_000 : 4.5 * 60_000 });
  await expect
    .poll(async () => (await page.context().cookies()).some((c) => c.name === "authToken"), { message: "authToken cookie" })
    .toBe(true);
  await page.context().storageState({ path: statePath });
});
