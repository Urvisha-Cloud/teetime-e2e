import type { TestInfo } from "@playwright/test";
import type { BookingApp, CreatedBooking } from "../support/booking-app";
import { env } from "../support/env";
import { unwrap } from "../support/network";
import {
  GIFT_CODE_KEY_DELAY_MS,
  addPlayers,
  askGiftCode,
  bookingSuite,
  cancelInUi,
  chooseNewTime,
  confirmChangeDetails,
  continueExtend,
  dueBeforeWallet,
  expectBookingGone,
  expectConfirmed,
  openExtendPopup,
  orBlocked,
  outsideCreditHours,
  presetSlots,
  requireBookingCreation,
  rescheduleSlotsRange,
  selectRequestedSlot,
  showBookingEmail,
  startReschedule,
} from "./helper";
import { expect, test, testUser } from "./fixtures";

/**
 * Test cases 107–110 and 133–136 — a booking paid with the wallet credit when there is some, otherwise by card. Wallet credit is
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
 *  TC133–136  the same booking: reschedule -> group size -> extend -> cancel; every extra cost is paid by the wallet
 *         first, then the card; the cancellation puts the wallet's part (less the fee) back
 *
 * File name "x-…": runs after every card-paid case (files run in name order), so the refund of this booking cannot
 * reach them; y-gift-card and z-membership follow.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
/** The account the run is logged in as (the wallet belongs to it). */
const testUserEmail = () => testUser.email ?? env.testEmail ?? "the test user";

test.describe("Wallet credit, otherwise card: create -> reschedule -> group size -> extend -> cancel @main @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let balanceBefore = 0; // what GET /wallet/balance said when Booking Details opened
  let used = 0; // wallet credit the booking uses
  let cardPart = 0; // what the card pays
  let booking: CreatedBooking | undefined; // as it is after the latest step
  let rescheduled = false;
  let resized = false;
  let extended = false;
  const extraSlots = presetSlots(env.extendBy);

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
    await app.openIfNeeded();
    const sel = await selectRequestedSlot(app, testInfo, [], {
      // the same bay must be free for the reschedule and the extension (TC133, TC135); outside member credit hours
      alsoFree: rescheduleSlotsRange(extraSlots),
      ...(await outsideCreditHours(app)),
    });

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
    const price = dueBeforeWallet(await modal.innerText());
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

  /**
   * Runs a change (reschedule / group size / extend) of the wallet booking and checks how its extra cost was paid: the
   * wallet first, as far as it goes, the card the rest — and the wallet went down by exactly its part.
   */
  async function changePaidByWallet(testInfo: TestInfo, what: string, change: () => Promise<CreatedBooking>) {
    const paid = async () => {
      const p = (await app.fetchBooking(booking!.bookingId))?.paymentBreakdown ?? {};
      return { wallet: Number(p.walletAmount || 0), card: Number(p.cardAmount || 0) };
    };
    const wallet = await app.walletBalance();
    const before = await paid();
    booking = await change();
    const after = await paid();
    const fromWallet = round2(after.wallet - before.wallet);
    const fromCard = round2(after.card - before.card);
    const note = `${what}: wallet $${fromWallet.toFixed(2)} + card $${fromCard.toFixed(2)} (wallet had $${wallet.toFixed(2)})`;
    testInfo.annotations.push({ type: "payment", description: note });
    console.log(`[teetime-e2e] wallet: ${note}`);
    expect(fromWallet, `${what}: the wallet pays first, as far as it goes`).toBeCloseTo(Math.min(wallet, round2(fromWallet + fromCard)), 2);
    await expect
      .poll(async () => round2(await app.walletBalance()), { message: `${what}: wallet balance down by what it paid`, timeout: 20_000 })
      .toBe(round2(wallet - fromWallet));
    await app.viewMyBooking(booking);
  }

  test("TC133: reschedule the wallet booking -> the 2 hr after it -> wallet credit pays the difference, the card the rest -> calendar", async ({}, testInfo) => {
    test.skip(!booking, "TC108 did not create the booking");
    await app.viewMyBooking(booking!); // TC108 left the Booking Confirmed screen open
    await changePaidByWallet(testInfo, "reschedule", async () => {
      await startReschedule(app, booking!);
      const next = await chooseNewTime(app, booking!, env.rescheduleStart, env.rescheduleEnd);
      await confirmChangeDetails(app, testInfo, "reschedule", next, { pickGroupSize: true });
      return next;
    });
    rescheduled = true;
  });

  test(`TC134: update the group size of the wallet booking -> ${env.groupSizeUpdate} players -> calendar`, async ({}, testInfo) => {
    test.skip(!rescheduled, "TC133 did not reschedule the booking");
    await changePaidByWallet(testInfo, "group size", async () => {
      const next = await addPlayers(app, booking!, env.groupSizeUpdate);
      await confirmChangeDetails(app, testInfo, "reschedule", next);
      return next;
    });
    resized = true;
  });

  test(`TC135: extend the wallet booking -> ${env.extendBy} -> calendar`, async ({}, testInfo) => {
    test.skip(!resized, "TC134 did not update the group size");
    await changePaidByWallet(testInfo, "extend", async () => {
      const popup = await openExtendPopup(app, booking!);
      await app.guidedClick(popup.getByRole("button", { name: env.extendBy, exact: true }));
      const next = await continueExtend(app, popup, booking!, extraSlots);
      await confirmChangeDetails(app, testInfo, "extend", next);
      return next;
    });
    extended = true;
  });

  test("TC136: cancel the wallet booking -> refund shown and applied -> the wallet's part is back in the wallet -> slots free", async ({}, testInfo) => {
    test.skip(!extended, "TC135 did not extend the booking");
    const wallet = await app.walletBalance();
    const p = (await app.fetchBooking(booking!.bookingId))?.paymentBreakdown ?? {};
    await cancelInUi(app, testInfo, booking!, { checkRefund: true });
    suite.markCancelled();
    const refunded = Number((await app.fetchBooking(booking!.bookingId))?.metadata?.refundAmount ?? 0);
    // The fee is taken from the card first, then the wallet; what is left of the wallet's part comes back to it
    const card = Number(p.cardAmount || 0);
    const paidWallet = Number(p.walletAmount || 0);
    const fee = round2(card + paidWallet - refunded);
    const back = round2(paidWallet - Math.max(0, round2(fee - card)));
    testInfo.annotations.push({ type: "wallet", description: `refund to the wallet: $${back.toFixed(2)} of $${paidWallet.toFixed(2)}` });
    await expect
      .poll(async () => round2(await app.walletBalance()), { message: `wallet balance = $${wallet.toFixed(2)} + $${back.toFixed(2)}`, timeout: 20_000 })
      .toBe(round2(wallet + back));
    await expectBookingGone(app, booking!);
  });
});
