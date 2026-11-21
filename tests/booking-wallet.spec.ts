import type { BookingApp, CreatedBooking } from "../support/booking-app";
import { env } from "../support/env";
import { unwrap } from "../support/network";
import {
  GIFT_CODE_KEY_DELAY_MS,
  askGiftCode,
  bookingSuite,
  expectConfirmed,
  orBlocked,
  requireBookingCreation,
  selectRequestedSlot,
  showBookingEmail,
} from "./helper";
import { expect, test, testUser } from "./fixtures";

/**
 * Test cases 107–110 — a booking paid with the wallet credit when there is some, otherwise by card. Wallet credit is
 * applied by itself (My Wallet: "Credits auto-apply on your next booking"; Booking Details has no switch for it).
 *
 *  TC107  only when the wallet is empty: sidebar "My Wallet" -> "Redeem Gift" -> the "Redeem gift card" modal -> a popup
 *         asks YOU for the gift card code (e.g. from admin; headless runs use TEETIME_GIFT_CARD_CODE) -> the code is
 *         typed into "Gift code" -> Redeem -> the wallet balance goes up by the card's value -> back to "Book Your Bay".
 *         The wallet already has credit -> nothing to redeem (TC108 uses it). Popup "Skip" -> no redeem, TC108 pays by card.
 *         A refused code (used up, invalid) -> skipped with the app's message; TC108 then pays by card.
 *  TC108  book a free slot: opening Booking Details makes the app call GET /wallet/balance — that balance decides:
 *           credit  -> "Wallet credits" in the price, "You pay" = price − credit, the card pays the rest (if any)
 *           no credit -> no wallet line, "You pay" = the price, the card pays it all
 *         -> waiver -> Confirm -> Booking Confirmed
 *  TC109  the saved booking (paymentBreakdown): walletAmount = the credit used, cardAmount = the rest
 *  TC110  the wallet afterwards: balance = before − credit used (unchanged when none was used), and the wallet's
 *         history has a debit for THIS booking of the credit used (none when the card paid it all)
 *
 * The booking is cancelled afterwards (TEETIME_CLEANUP=true).
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
/** The account the run is logged in as (the wallet belongs to it). */
const testUserEmail = () => testUser.email ?? env.testEmail ?? "the test user";

/** The session price before the wallet: "Session price after discounts" (or "Session price" without discounts). */
function sessionPrice(modalText: string): number {
  const m =
    modalText.match(/Session price after discounts\s*\$(\d+(?:,\d{3})*\.\d{2})/) ?? modalText.match(/Session price\s*\$(\d+(?:,\d{3})*\.\d{2})/);
  if (!m) throw new Error(`No session price in Booking Details: ${modalText.slice(0, 300)}`);
  return Number(m[1].replace(/,/g, ""));
}

test.describe("Wallet credit, otherwise card @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let balanceBefore = 0; // what GET /wallet/balance said when Booking Details opened
  let used = 0; // wallet credit the booking uses
  let cardPart = 0; // what the card pays
  let booking: CreatedBooking | undefined;

  test("TC107: empty wallet -> My Wallet -> Redeem Gift -> popup: enter the gift card code -> Redeem -> wallet balance goes up", async ({ headless }, testInfo) => {
    requireBookingCreation();
    await app.openIfNeeded();
    const start = await app.walletBalance();
    if (start > 0) {
      const note = `the wallet already has $${start.toFixed(2)} for ${testUserEmail()}: nothing to redeem, TC108 uses it`;
      testInfo.annotations.push({ type: "wallet", description: note });
      console.log(`[teetime-e2e] wallet: ${note}`);
      return;
    }
    test.skip(headless && !env.giftCardCode, "Empty wallet, headless run without TEETIME_GIFT_CARD_CODE: nothing to redeem (TC108 pays by card)");
    const page = app.page;

    // Sidebar "My Wallet" -> "Redeem Gift" -> the "Redeem gift card" modal
    await app.guidedClick(page.getByText("My Wallet", { exact: true }).first(), { read: app.readMs });
    await expect(page.getByRole("heading", { name: "My Wallet" }), "the My Wallet page").toBeVisible();
    await app.guidedClick(page.getByRole("button", { name: /Redeem Gift/i }));
    const dialog = page.getByRole("dialog").filter({ hasText: /Redeem gift card/i });
    await expect(dialog, 'the "Redeem gift card" modal').toBeVisible();
    await app.readPause();
    const field = dialog.getByPlaceholder(/gift code/i);
    const redeem = dialog.getByRole("button", { name: /^Redeem$/i });

    // The popup asks YOU for the code (headless: TEETIME_GIFT_CARD_CODE) -> typed into "Gift code" -> Redeem
    const code = headless ? env.giftCardCode : await askGiftCode(app, testInfo, dialog, { primaryButton: redeem, target: '"Gift code"' });
    test.skip(!code, "No gift card code entered in the popup: nothing redeemed (TC108 pays by card)");
    await app.guidedClick(field);
    await field.pressSequentially(code, { delay: GIFT_CODE_KEY_DELAY_MS });
    await app.guidedClick(redeem, { read: app.readMs });

    // Redeemed: the balance goes up — or the modal says why the code cannot be used
    const refused = dialog.getByText(/invalid|expired|not found|exhausted|already|no balance|failed|not valid/i).first();
    let balance = start;
    for (const end = Date.now() + 20_000; Date.now() < end && balance <= start; ) {
      if (await refused.isVisible().catch(() => false)) {
        const why = (await refused.innerText()).trim();
        testInfo.annotations.push({ type: "gift-card", description: `${code}: ${why}` });
        await page.keyboard.press("Escape");
        test.skip(true, `The gift card code ${code} cannot be redeemed ("${why}"): TC108 pays by card`);
      }
      balance = await app.walletBalance();
      if (balance <= start) await page.waitForTimeout(500);
    }
    expect(balance, `wallet balance above $${start.toFixed(2)} after redeeming ${code}`).toBeGreaterThan(start);
    const added = round2(balance - start);
    testInfo.annotations.push({ type: "wallet", description: `redeemed ${code}: +$${added.toFixed(2)} -> $${balance.toFixed(2)}` });
    console.log(`[teetime-e2e] wallet: redeemed ${code}, +$${added.toFixed(2)} -> $${balance.toFixed(2)}`);

    // The modal closes by itself (or with Escape); My Wallet shows the new balance
    const closed = await dialog.waitFor({ state: "hidden", timeout: 5_000 }).then(() => true, () => false);
    if (!closed) await page.keyboard.press("Escape");
    await expect(dialog, 'the "Redeem gift card" modal closed').toBeHidden();
    await expect(page.getByText(`$${balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`).first(), "the new balance on My Wallet").toBeVisible({ timeout: 10_000 });
    await app.readPause();

    // Back to the calendar for the booking (TC108)
    await app.guidedClick(page.getByText("Book Your Bay", { exact: true }).first());
  });

  test("TC108: Booking Details checks the wallet balance -> wallet credit if there is some, otherwise card -> Booking Confirmed", async ({}, testInfo) => {
    requireBookingCreation();
    const sel = await selectRequestedSlot(app, testInfo);

    // Opening Booking Details makes the app ask for the wallet balance (GET /wallet/balance)
    const walletCall = app.page
      .waitForResponse((r) => r.request().method() === "GET" && /\/wallet\/balance(\?|$)/.test(r.url()), { timeout: 10_000 })
      .catch(() => null);
    const modal = await app.openBookingModal(sel);
    const response = await walletCall;
    // A "304 Not Modified" answer (the browser reuses its cached copy) has no body, so it does not tell the balance:
    // then — or when the app made no new request at all — the test asks the same endpoint itself
    const fromApp = response && response.status() === 200 ? unwrap<any>(await response.json().catch(() => null))?.balance : undefined;
    balanceBefore = fromApp != null ? Number(fromApp) : await app.walletBalance();
    const source = fromApp != null ? "the app's GET /wallet/balance when Booking Details opened" : `GET /wallet/balance (the app's answer: ${response ? `HTTP ${response.status()}, no balance in it` : "none"})`;
    testInfo.annotations.push({ type: "wallet", description: `$${balanceBefore.toFixed(2)} for ${testUserEmail()} (${source})` });
    console.log(`[teetime-e2e] wallet: $${balanceBefore.toFixed(2)} for ${testUserEmail()}`);
    await app.readPause();
    await app.selectGroupSize(modal, 1);

    // Wallet credit first, the card for the rest — or the card for everything when there is no credit
    const price = sessionPrice(await modal.innerText());
    used = round2(Math.min(Math.max(balanceBefore, 0), price));
    cardPart = round2(price - used);
    testInfo.annotations.push({
      type: "payment",
      description: used > 0 ? `$${price.toFixed(2)}: wallet $${used.toFixed(2)} + card $${cardPart.toFixed(2)}` : `$${price.toFixed(2)}: no wallet credit, card pays it all`,
    });
    if (used > 0) await expect(modal, "the wallet credit in the price").toContainText(/Wallet credits/i);
    else await expect(modal, "no wallet line without credit").not.toContainText(/Wallet credits/i);
    expect(await app.amountToPay(modal), `"You pay" = $${price.toFixed(2)} − $${used.toFixed(2)} wallet credit`).toBeCloseTo(cardPart, 2);

    await app.scrollThrough(modal);
    await app.acceptWaiver(modal);
    if (cardPart > 0) await orBlocked(testInfo, () => app.preparePayment(modal)); // the card pays the rest / all of it
    const bookingId = await app.confirmBooking(modal, { read: Math.min(1500, app.readMs) });
    testInfo.annotations.push({ type: "bookingId", description: bookingId });
    booking = { ...sel, bookingId, groupSize: 1 };
    suite.track(booking);
    await expectConfirmed(app, booking, { pause: false });
    await showBookingEmail(app, testInfo, booking, "confirmed");
  });

  test("TC109: the saved booking is paid as Booking Details showed: wallet credit + card", async ({}, testInfo) => {
    test.skip(!booking, "TC108 did not create the booking");
    const p = (await app.fetchBooking(booking!.bookingId))?.paymentBreakdown ?? {};
    testInfo.annotations.push({ type: "paymentBreakdown", description: JSON.stringify(p).slice(0, 300) });
    expect(Number(p.walletAmount || 0), "paid from the wallet").toBeCloseTo(used, 2);
    expect(Number(p.cardAmount || 0), "paid by card").toBeCloseTo(cardPart, 2);
  });

  test("TC110: the wallet afterwards: down by the credit used (unchanged without credit)", async ({}, testInfo) => {
    test.skip(!booking, "TC108 did not create the booking");
    const expected = round2(balanceBefore - used);
    await expect
      .poll(async () => round2(await app.walletBalance()), { message: `wallet balance = $${balanceBefore.toFixed(2)} − $${used.toFixed(2)}`, timeout: 20_000 })
      .toBe(expected);
    // The history comes in pages (the newest 20), so look for THIS booking's entry instead of counting entries
    const transactions = await app.walletTransactions();
    const forBooking = transactions.filter((t: any) => t.referenceType === "booking" && t.referenceId === booking!.bookingId);
    testInfo.annotations.push({
      type: "wallet",
      description: `after: $${expected.toFixed(2)}; this booking's entries: ${JSON.stringify(forBooking.map((t: any) => ({ type: t.type, amount: t.amount, description: t.description })))}`.slice(0, 300),
    });
    if (used > 0) {
      expect(forBooking.length, "the wallet history has a payment for this booking").toBeGreaterThan(0);
      expect(forBooking[0].type, "a payment out of the wallet").toBe("debit");
      expect(Number(forBooking[0].amount), "the amount taken from the wallet").toBeCloseTo(used, 2);
    } else {
      expect(forBooking.length, "no wallet entry for a booking paid by card only").toBe(0);
    }
  });
});
