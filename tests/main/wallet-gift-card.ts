import type { Locator, TestInfo } from "@playwright/test";
import type { BookingApp, CreatedBooking, SelectedBooking } from "../../support/booking-app";
import { env } from "../../support/env";
import {
  applyGiftCode,
  askAndApplyGiftCode,
  askGiftCode,
  bookingSuite,
  cancelInUi,
  ensureSmallWallet,
  confirmNewBooking,
  expectBookingGone,
  expectGiftCardBalance,
  expectWalletBalance,
  outsideCreditHours,
  requireBookingCreation,
  selectRequestedSlot,
  setBookingHours,
  slotsAfterRequested,
  type RefundLines,
} from "../helper";
import { expect, test } from "../fixtures";
import { dueBeforeWallet, paidWith, refundSplit, round2 } from "../money";

/**
 * Test cases 33 and 34 — ONE booking paid in several ways at once, then cancelled in the same case: every way gets its money back.
 * Runs after the wallet cases (which leave credit in the wallet) and before the gift card cases (tests/main.spec.ts).
 *
 *  TC33  wallet + gift card: the wallet has a small credit (WALLET; otherwise a popup asks you to set it in admin, the test
 *         goes on by itself) -> book a free hour -> Booking Details: "Wallet credits" in the price -> popup: you type the
 *         gift card code (headless: TEETIME_SMALL_GIFT_CARD_CODE) -> "Have a gift card?" -> Apply -> the gift card pays the
 *         rest (the card what it does not cover) -> waiver -> Confirm -> Booking Confirmed. Saved: wallet, gift card and
 *         card parts as shown; the wallet and the gift card are down by their part. Then cancel it (90% refund): the
 *         cancel popup shows a refund line per way of payment -> Confirm cancellation -> the refunds saved on the
 *         booking -> the wallet balance and the gift card balance are up by them -> slots free
 *
 *  TC34  card + wallet + gift card: the gift card of TC33 again when it fits (otherwise a popup asks for a code) -> End
 *         Time: as long as needed (up to MAX_HOURS) that the gift card is used up and the card still pays a real part ->
 *         "Have a gift card?" -> Apply -> the card pays the rest -> Confirm -> saved and balances as in TC33. Then cancel it
 *         (90% refund): "Card", "Wallet" and "Gift card" refund lines -> all three refunded, checked as in TC33
 *
 * The 10% fee is taken from the card first, then the gift card, then the wallet (as the app does it): without a card the
 * gift card pays the fee; with a card the gift card and the wallet come back in full and the card less the fee.
 */

/** Wallet credit the bookings need: some, but less than 1 hr costs, so that a part is left for the gift card. */
const WALLET = { min: 1, max: 6, suggest: 5 };
const REFUND_PERCENT = 90;
/** TC34: the longest booking, and what must at least go back to the card after the fee (so its refund can be checked). */
const MAX_HOURS = 5;
const MIN_CARD_REFUND = 1;

/** A booking and what each way of payment paid; the balances are the ones right after it. */
type Paid = { booking: CreatedBooking; giftCode: string; wallet: number; gift: number; card: number; walletLeft: number; giftLeft: number };
type Suite = ReturnType<typeof bookingSuite>;

/** The gift card code entered for TC33, used again by TC34. */
let usedGiftCode = "";

/** A free hour (the bay also free for `extraSlots` after it) -> Booking Details, group size 1, wallet credit applied by itself. */
async function openWithWallet(app: BookingApp, testInfo: TestInfo, wallet: number, extraSlots = 0) {
  const sel = await selectRequestedSlot(app, testInfo, [], {
    rescheduleRoom: false, // only cancelled afterwards
    ...(extraSlots > 0 ? { alsoFree: slotsAfterRequested(extraSlots) } : {}),
    ...(await outsideCreditHours(app)), // a member's credit would pay it instead
  });
  const modal = await app.openBookingModal(sel);
  await app.readPause();
  await app.selectGroupSize(modal, 1);
  const price = dueBeforeWallet(await modal.innerText());
  expect(price, `the booking costs more than the wallet's $${wallet.toFixed(2)}, so a part is left`).toBeGreaterThan(wallet);
  await expect(modal, "the wallet credit in the price").toContainText(/Wallet credits/i);
  expect(await app.amountToPay(modal), `"You pay" = $${price.toFixed(2)} − $${wallet.toFixed(2)} wallet credit`).toBeCloseTo(price - wallet, 2);
  return { sel, modal, price };
}

/** Wallet and gift card are applied: waiver, card for the rest -> Confirm -> Booking Confirmed -> saved amounts and balances. */
async function confirmPaid(
  app: BookingApp,
  suite: Suite,
  testInfo: TestInfo,
  modal: Locator,
  sel: SelectedBooking,
  { giftCode, wallet, gift, card }: { giftCode: string; wallet: number; gift: number; card: number },
): Promise<Paid> {
  await expect(modal, "the wallet credit is still in the price with the gift card").toContainText(/Wallet credits/i);
  const price = dueBeforeWallet(await modal.innerText());
  expect(round2(wallet + gift + card), "wallet + gift card + card = the price").toBeCloseTo(price, 2);
  const walletBefore = await app.walletBalance();
  const giftBefore = await app.giftCardBalance(giftCode);
  const note = `${sel.startTime}–${sel.endTime} $${price.toFixed(2)}: wallet $${wallet.toFixed(2)} + gift card $${gift.toFixed(2)} + card $${card.toFixed(2)}`;
  testInfo.annotations.push({ type: "payment", description: note });
  console.log(`[teetime-e2e] payment: ${note}`);
  await app.readPause();

  const booking = await confirmNewBooking(app, testInfo, modal, sel, { track: suite.track });

  // Saved as shown, and both balances are down by their part
  const saved = await app.fetchBooking(booking.bookingId);
  testInfo.annotations.push({ type: "paymentBreakdown", description: JSON.stringify(saved?.paymentBreakdown ?? {}).slice(0, 300) });
  const paid = paidWith(saved);
  expect(paid.wallet, "paid from the wallet").toBeCloseTo(wallet, 2);
  expect(paid.gift, "paid with the gift card").toBeCloseTo(gift, 2);
  expect(paid.card, "paid by card").toBeCloseTo(card, 2);
  const walletLeft = round2(walletBefore - wallet);
  const giftLeft = round2(giftBefore - gift);
  await expectWalletBalance(app, walletLeft, "wallet balance down by its part");
  await expectGiftCardBalance(app, giftCode, giftLeft, "gift card balance down by its part");
  return { booking, giftCode, wallet, gift, card, walletLeft, giftLeft };
}

/** Cancels the booking (90%): the refund of each way of payment shown, saved, and back in the wallet and the gift card. */
async function cancelRefundsAll(app: BookingApp, suite: Suite, testInfo: TestInfo, paid: Paid) {
  const { booking, giftCode, wallet, gift, card, walletLeft, giftLeft } = paid;
  await app.viewMyBooking(booking); // the create case left the Booking Confirmed screen open

  // The fee is taken from the card first, then the gift card, then the wallet
  const back = refundSplit({ card, wallet, gift, credit: 0, total: round2(card + wallet + gift) }, REFUND_PERCENT);
  const fee = back.fee;
  expect(back.gift, "a refund is due to the gift card").toBeGreaterThan(0);
  expect(back.wallet, "a refund is due to the wallet").toBeGreaterThan(0);
  const note =
    `refund: wallet $${back.wallet.toFixed(2)} of $${wallet.toFixed(2)} + gift card $${back.gift.toFixed(2)} of $${gift.toFixed(2)} + ` +
    `card $${back.card.toFixed(2)} of $${card.toFixed(2)} (fee $${fee.toFixed(2)})`;
  testInfo.annotations.push({ type: "refund-expected", description: note });
  console.log(`[teetime-e2e] ${note}`);

  const refundLines: RefundLines = { Wallet: back.wallet, "Gift card": back.gift };
  if (back.card > 0) refundLines.Card = back.card;
  await cancelInUi(app, testInfo, booking, { expectPercent: REFUND_PERCENT, refundLines });
  suite.markCancelled();

  // Saved on the booking, per way of payment (stripeRefund: what Stripe gave back to the card)
  const saved = (await app.fetchBooking(booking.bookingId))?.metadata?.refundBreakdown ?? {};
  testInfo.annotations.push({ type: "refundBreakdown", description: JSON.stringify(saved).slice(0, 300) });
  const giftSaved = (saved.giftCardRefunds ?? []).reduce((sum: number, g: any) => sum + Number(g.amount || 0), 0);
  expect(Number(saved.walletRefund || 0), "refunded to the wallet").toBeCloseTo(back.wallet, 2);
  expect(giftSaved, "refunded to the gift card").toBeCloseTo(back.gift, 2);
  expect(Number(saved.stripeRefund || 0), "refunded to the card").toBeCloseTo(back.card, 2);

  // The money is really back
  await expectWalletBalance(app, walletLeft + back.wallet, `wallet balance = $${walletLeft.toFixed(2)} + $${back.wallet.toFixed(2)}`);
  await expectGiftCardBalance(app, giftCode, giftLeft + back.gift, `gift card balance = $${giftLeft.toFixed(2)} + $${back.gift.toFixed(2)}`);
  await expectBookingGone(app, booking);
}

test.describe("Wallet + gift card: create -> cancel, both refunded @wallet-gift-card @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let paid: Paid | undefined;

  test("TC33: create booking with wallet + gift card -> both apply -> Booking Confirmed -> cancel -> wallet and gift card both refunded", async ({ headless }, testInfo) => {
    requireBookingCreation();
    testInfo.setTimeout(testInfo.timeout * 2); // one case: the booking and its cancellation
    test.skip(headless && !env.smallGiftCardCode, "Headless run without a small gift card: set TEETIME_SMALL_GIFT_CARD_CODE in .env (or run --headed)");
    const wallet = await ensureSmallWallet(app, testInfo, WALLET);
    const { sel, modal } = await openWithWallet(app, testInfo, wallet);
    // The gift card pays what is left, the card only what the gift card does not cover
    const { code, before, after } = await askAndApplyGiftCode(app, testInfo, modal, headless, env.smallGiftCardCode);
    usedGiftCode = code;
    paid = await confirmPaid(app, suite, testInfo, modal, sel, { giftCode: code, wallet, gift: round2(before - after), card: after });

    // Cancel it (90%): both refunds shown, saved and back in the wallet and on the gift card -> slots free
    await cancelRefundsAll(app, suite, testInfo, paid);
  });
});

test.describe("Card + wallet + gift card: create -> cancel, all refunded @wallet-gift-card @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let paid: Paid | undefined;

  test("TC34: create booking with card + wallet + gift card -> all three pay a part -> Booking Confirmed -> cancel -> card, wallet and gift card all refunded", async ({ headless }, testInfo) => {
    requireBookingCreation();
    testInfo.setTimeout(testInfo.timeout * 2); // one case: the booking and its cancellation
    test.skip(headless && !env.smallGiftCardCode, "Headless run without a small gift card: set TEETIME_SMALL_GIFT_CARD_CODE in .env (or run --headed)");
    const wallet = await ensureSmallWallet(app, testInfo, WALLET);
    const { sel: hour, modal, price: perHour } = await openWithWallet(app, testInfo, wallet, (MAX_HOURS - 1) * 4);
    // What the card gets back of a booking for `price`: price − wallet − the whole gift card − the fee
    const cardRefund = (price: number, gift: number) => round2((price * REFUND_PERCENT) / 100 - wallet - gift);
    const maxGift = Math.floor((perHour * MAX_HOURS * REFUND_PERCENT) / 100 - wallet - MIN_CARD_REFUND);

    // 1. A gift card that is used up by at most MAX_HOURS, so the card pays too: TC33's, or the one you enter
    let giftCode = "";
    let giftBalance = 0;
    let problem = "";
    const tries = headless ? 1 : 3;
    for (let attempt = usedGiftCode ? 0 : 1; attempt <= tries && !giftCode; attempt++) {
      const code =
        attempt === 0
          ? usedGiftCode
          : headless
            ? env.smallGiftCardCode!
            : await askGiftCode(app, testInfo, modal, { hint: `${problem ? `${problem}. ` : ""}The card must pay too: use a code with up to $${maxGift.toFixed(2)} left.` });
      test.skip(!code, "No gift card code entered in the popup");
      const card = await app.giftCard(code);
      if (!card.valid) problem = `${code}: ${card.message}`;
      else if (card.balance > maxGift) problem = `${code} has $${card.balance.toFixed(2)} left, too much`;
      else [giftCode, giftBalance] = [code, card.balance];
      if (!giftCode) testInfo.annotations.push({ type: "gift-card", description: problem });
    }
    test.skip(!giftCode, `No gift card that leaves a part for the card (${problem}): use one with up to $${maxGift.toFixed(2)} left`);

    // 2. End Time: as long as needed that the card pays a real part (its refund after the fee is at least MIN_CARD_REFUND)
    let sel: SelectedBooking = hour;
    let price = perHour;
    for (let hours = 2; cardRefund(price, giftBalance) < MIN_CARD_REFUND && hours <= MAX_HOURS; hours++) {
      if (cardRefund(perHour * hours, giftBalance) < MIN_CARD_REFUND && hours < MAX_HOURS) continue; // still too short
      sel = await setBookingHours(app, modal, hour, hours);
      await expect
        .poll(async () => dueBeforeWallet(await modal.innerText()), { message: `the price for ${hours} hr`, timeout: 10_000 })
        .toBeGreaterThan(price);
      price = dueBeforeWallet(await modal.innerText());
    }
    expect(cardRefund(price, giftBalance), `a part of the $${price.toFixed(2)} is left for the card`).toBeGreaterThanOrEqual(MIN_CARD_REFUND);

    // 3. Wallet first (by itself), then the gift card, then the card
    const { before, after } = await applyGiftCode(app, testInfo, modal, giftCode);
    expect(round2(before - after), "the gift card pays all that is left on it").toBeCloseTo(giftBalance, 2);
    paid = await confirmPaid(app, suite, testInfo, modal, sel, { giftCode, wallet, gift: round2(before - after), card: after });

    // Cancel it (90%): card, wallet and gift card refunds shown, saved and back -> slots free
    await cancelRefundsAll(app, suite, testInfo, paid);
  });
});
