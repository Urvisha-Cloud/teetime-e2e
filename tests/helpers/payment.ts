// Paying by card only: the wallet and member credit the app applies by itself, and the balances after a payment.
import type { TestInfo } from "@playwright/test";
import { BookingApp, type CreatedBooking } from "../../support/booking-app";
import { env } from "../../support/env";
import { expect, test, testUser } from "../fixtures";
import { paidWith, round2 } from "../money";

// ───────────────────────────── paying by card only ─────────────────────────────
// The app applies wallet credit (and a member's credit, in the plan's credit hours) by itself; Booking Details has no
// switch for either. So a booking is paid by card alone only with an empty wallet and outside credit hours. Cancelling
// a wallet-paid booking puts the money back into the wallet: the next booking would use it again.

/** How long the "empty the wallet" popup waits (ms). */
const EMPTY_WALLET_PROMPT_MS = 10 * 60_000;

/** For a member: the part of the day after the plan's credit hours (no member credit there). Not a member: {}. */
export async function outsideCreditHours(app: BookingApp): Promise<{ dayWindow?: { from: number; to: number } }> {
  const m = await app.membership();
  if (m?.status !== "active") return {};
  const ends: number[] = (m.plan?.creditWindows ?? []).map((w: any) => {
    const [h, min] = String(w.endTime).split(":").map(Number);
    return h * 60 + min;
  });
  return ends.length ? { dayWindow: { from: Math.max(...ends), to: 24 * 60 } } : {};
}

/**
 * The wallet is empty, so the card pays. With credit in it a popup asks YOU to remove it in admin (Users -> the wallet
 * icon -> "Remove Credits"); the test watches the balance and goes on by itself at $0. "Skip" (or no change within
 * EMPTY_WALLET_PROMPT_MS, or a headless run) skips the test: it would be paid from the wallet.
 */
export async function ensureEmptyWallet(app: BookingApp, testInfo: TestInfo, payWith = "card") {
  await waitForWallet(app, testInfo, {
    ok: (balance) => balance <= 0,
    title: "Empty the wallet first",
    intro: `These cases pay with the ${payWith}, but the app uses wallet credit first.`,
    todo: "Remove Credits. The test continues by itself at $0.00.",
    why: `the app would use it instead of the ${payWith}: set it to $0.00 in admin (Users -> wallet icon -> Remove Credits), then run again`,
    done: `emptied in admin: the ${payWith} pays`,
  });
}

/**
 * The wallet has some credit, but less than a booking costs ($min–$max), so the wallet AND a gift card can pay for the
 * same booking. Otherwise the same popup as ensureEmptyWallet asks YOU to set it in admin. Returns the balance.
 */
export async function ensureSmallWallet(app: BookingApp, testInfo: TestInfo, { min, max, suggest }: { min: number; max: number; suggest: number }) {
  return waitForWallet(app, testInfo, {
    ok: (balance) => balance >= min && balance <= max,
    title: `Set the wallet to $${suggest.toFixed(2)}`,
    intro: "This case pays one booking with the wallet and a gift card, so the wallet must cover only a part of it.",
    todo: `Add Credits or Remove Credits. The test continues by itself between $${min.toFixed(2)} and $${max.toFixed(2)}.`,
    why: `a booking paid by wallet + gift card needs $${min.toFixed(2)}–$${max.toFixed(2)} in it: set it to $${suggest.toFixed(2)} in admin (Users -> wallet icon), then run again`,
    done: "set in admin: the wallet pays a part, the gift card the rest",
  });
}

/** Waits until the wallet balance is `ok`: a popup asks YOU to change it in admin (see ensureEmptyWallet). Returns it. */
async function waitForWallet(
  app: BookingApp,
  testInfo: TestInfo,
  { ok, title, intro, todo, why, done }: { ok: (balance: number) => boolean; title: string; intro: string; todo: string; why: string; done: string },
): Promise<number> {
  await app.openIfNeeded();
  let balance = await app.walletBalance();
  if (ok(balance)) return balance;
  const email = testUser.email ?? env.testEmail;
  const reason = () => `The wallet of ${email} has $${balance.toFixed(2)}; ${why}`;
  test.skip(testInfo.project.use.headless !== false, reason());
  testInfo.setTimeout(testInfo.timeout + EMPTY_WALLET_PROMPT_MS); // waiting for you does not count against the test
  console.log(`[teetime-e2e] wallet: $${balance.toFixed(2)}. ${title}: in admin, the test then goes on by itself`);
  await app.page.evaluate(({ email, title, intro, todo }) => {
    (window as any).__teetimeWalletSkip = false;
    document.getElementById("teetime-wallet-prompt")?.remove();
    const box = document.createElement("div");
    box.id = "teetime-wallet-prompt";
    box.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.5);font-family:inherit";
    box.innerHTML = `
      <div role="dialog" aria-modal="true" style="background:#fff;color:#0f172a;border-radius:20px;padding:24px;width:min(440px,calc(100% - 32px));box-shadow:0 25px 50px -12px rgba(0,0,0,.25)">
        <h2 data-title style="margin:0 0 8px;font-size:20px;font-weight:700"></h2>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#64748b"><span data-intro></span> In admin: Users → <b data-email></b> → wallet icon → <span data-todo></span></p>
        <div style="border:1px solid #bbf7d0;background:#f0fdf4;border-radius:12px;padding:12px 16px;font-size:14px;color:#166534">Wallet balance<div data-balance style="font-size:26px;font-weight:700"></div></div>
        <div style="display:flex;justify-content:flex-end;margin-top:20px"><button type="button" style="height:44px;padding:0 20px;border-radius:12px;border:1px solid #e2e8f0;background:#fff;font:inherit;font-weight:600;cursor:pointer">Skip</button></div>
      </div>`;
    for (const [key, text] of Object.entries({ email, title, intro, todo })) box.querySelector(`[data-${key}]`)!.textContent = text;
    box.querySelector("button")!.addEventListener("click", () => ((window as any).__teetimeWalletSkip = true));
    document.body.appendChild(box);
  }, { email: email ?? "", title, intro, todo });
  for (const end = Date.now() + EMPTY_WALLET_PROMPT_MS; !ok(balance) && Date.now() < end; ) {
    const skipped = await app.page.evaluate((text) => {
      const shown = document.querySelector("#teetime-wallet-prompt [data-balance]");
      if (shown) shown.textContent = text;
      return !!(window as any).__teetimeWalletSkip;
    }, `$${balance.toFixed(2)}`);
    if (skipped) break;
    await app.page.waitForTimeout(1500);
    balance = await app.walletBalance();
  }
  await app.page.evaluate(() => document.getElementById("teetime-wallet-prompt")?.remove());
  test.skip(!ok(balance), reason());
  testInfo.annotations.push({ type: "wallet", description: `$${balance.toFixed(2)}, ${done}` });
  await app.open(); // the app forgets the balance it had read
  return balance;
}

/** The saved booking is paid by card alone: nothing from the wallet, gift cards or member credit. */
export async function expectPaidByCard(app: BookingApp, testInfo: TestInfo, b: CreatedBooking) {
  const booking = await app.fetchBooking(b.bookingId);
  testInfo.annotations.push({ type: "paymentBreakdown", description: JSON.stringify(booking?.paymentBreakdown ?? {}).slice(0, 300) });
  const paid = paidWith(booking);
  expect(paid.wallet, "card only: nothing from the wallet").toBe(0);
  expect(paid.gift, "card only: nothing from a gift card").toBe(0);
  expect(paid.credit, "card only: no member credit").toBe(0);
  expect(paid.card, "card only: the card paid").toBeGreaterThan(0);
}

/** The wallet balance reaches `expected` (the backend books wallet payments and refunds a moment later). */
export async function expectWalletBalance(app: BookingApp, expected: number, message: string) {
  await expect.poll(async () => round2(await app.walletBalance()), { message, timeout: 20_000 }).toBe(round2(expected));
}

/** The balance left on gift card `code` reaches `expected`. */
export async function expectGiftCardBalance(app: BookingApp, code: string, expected: number, message: string) {
  await expect.poll(() => app.giftCardBalance(code), { message, timeout: 20_000 }).toBe(round2(expected));
}
