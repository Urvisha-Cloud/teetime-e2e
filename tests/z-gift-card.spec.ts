import type { BookingApp, CreatedBooking } from "../support/booking-app";
import { env } from "../support/env";
import { fromMinutes } from "../support/time";
import {
  applyGiftCode,
  askGiftCode,
  bookingSuite,
  cancelInUi,
  chooseNewTime,
  confirmChangeDetails,
  endTimeOption,
  expectBookingGone,
  expectConfirmed,
  orBlocked,
  requireBookingCreation,
  selectRequestedSlot,
  showBookingEmail,
  slotsAfterRequested,
  startReschedule,
} from "./helper";
import { expect, test } from "./fixtures";

/**
 * Test cases 111–115 — pay a booking with a gift card at checkout ("Have a gift card?" in Booking Details), then
 * reschedule it and cancel it.
 * The file name starts with "z-" so Playwright runs it LAST, after every other case (files run in name order).
 *
 *  TC111  the run's test user (the one already logged in; no other user): notes its wallet credit. The app applies
 *         wallet credit first — when it covers the 1-hr booking, "You pay" is $0 and Booking Details hides
 *         "Have a gift card?", so TC112 books longer (see below).
 *  TC112  book a free slot (1 hr; when the wallet covers that: End Time in the same Booking Details -> enough hours
 *         that something is left after the wallet, up to MAX_BOOKING_HOURS; no second selection, no reload): Booking Details -> a popup asks YOU for the gift card code (e.g. one made in
 *         admin; the field starts empty, you type it) -> "Apply this code" -> "Have a gift card?" -> the code
 *         typed -> Apply -> the gift card
 *         line and a lower "You pay" (the booking time is left as selected) -> waiver -> card for the rest, if any
 *         -> Confirm -> Booking Confirmed; the
 *         booking's paymentBreakdown lists the gift card (amount = what it paid) and cardAmount = the rest
 *  TC113  View My Booking -> the booking is on the calendar
 *  TC114  reschedule it to its own time + 1 hr more (same start, same bay) -> Reschedule details: the same gift card code
 *         (from the popup) pays the difference ("Have a gift card?"), the card the rest
 *         -> Booking Confirmed -> calendar shows it up to the new end
 *  TC115  cancel it -> the cancel popup's refund -> Confirm cancellation -> refund applied -> its slots free again
 *
 * Popup "Skip" (or no code within 5 min) -> TC112–115 are skipped. Headless runs show no popup: they use
 * TEETIME_GIFT_CARD_CODE, and are skipped without it. The booking is cancelled afterwards (TEETIME_CLEANUP=true).
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
/** TC114 reschedules the booking to its own time plus this many hours right after it. */
const RESCHEDULE_EXTRA_HOURS = 1;
/** Longest booking TC112 makes so that something is left to pay after the wallet credit. */
const MAX_BOOKING_HOURS = 8;

/** The session price before the gift card: "Session price after discounts" (or "Session price" without discounts). */
function sessionPrice(modalText: string): number {
  const m =
    modalText.match(/Session price after discounts\s*\$(\d+(?:,\d{3})*\.\d{2})/) ?? modalText.match(/Session price\s*\$(\d+(?:,\d{3})*\.\d{2})/);
  if (!m) throw new Error(`No session price in Booking Details: ${modalText.slice(0, 300)}`);
  return Number(m[1].replace(/,/g, ""));
}

test.describe("Gift card at checkout @main @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let ready = false;
  let giftCode = ""; // the code entered in the popup (TC112), used again for the reschedule (TC114)
  let walletBefore = 0; // the test user's wallet credit, applied before the gift card
  let booking: CreatedBooking | undefined;
  let rescheduled = false;
  let giftPaid = 0; // what the gift card paid at booking (TC112)

  test("TC111: the logged-in test user is ready for the gift card (wallet credit noted)", async ({ headless }, testInfo) => {
    requireBookingCreation();
    // Headed: you enter the code in a popup (TC112). Headless nobody can, so the code must be in .env
    test.skip(headless && !env.giftCardCode, "Headless run without a gift card code: set TEETIME_GIFT_CARD_CODE in .env (or run --headed)");
    await app.openIfNeeded(); // the run's own login: the calendar is already open
    walletBefore = await app.walletBalance();
    testInfo.annotations.push({ type: "wallet", description: `$${walletBefore.toFixed(2)} (applied before the gift card)` });
    if (walletBefore > 0) console.log(`[teetime-e2e] gift card: the test user's wallet has $${walletBefore.toFixed(2)}, applied first`);
    ready = true;
  });

  test("TC112: Booking Details -> popup: enter the gift card code -> Have a gift card? -> apply it -> the card pays the rest -> Booking Confirmed", async ({ headless }, testInfo) => {
    test.skip(!ready, "TC111 did not run (no gift card code)");
    // Select a free slot -> Booking Details (ONCE: no second selection, no page reload) -> group size 1 -> "You pay".
    // With wallet credit the booking may have to be made longer in this same Booking Details (End Time, below), so
    // the bay must then be free for up to MAX_BOOKING_HOURS; it must always be free RESCHEDULE_EXTRA_HOURS more after
    // the booking, for the longer reschedule (TC114)
    const roomAfter = (walletBefore > 0 ? MAX_BOOKING_HOURS - 1 : 0) + RESCHEDULE_EXTRA_HOURS;
    let sel = await selectRequestedSlot(app, testInfo, [], { alsoFree: slotsAfterRequested(roomAfter * 4) });
    const modal = await app.openBookingModal(sel);
    await app.readPause();
    await app.selectGroupSize(modal, 1);
    let before = await app.amountToPay(modal);
    if (before <= 0) {
      // The wallet credit (applied first) covers the whole booking, so Booking Details hides "Have a gift card?":
      // End Time -> enough hours that something is left after the wallet, for the gift card
      const hoursNow = (sel.endIdx + 1 - sel.startIdx) / 4;
      const perHour = sessionPrice(await modal.innerText()) / hoursNow;
      const hours = Math.floor(walletBefore / perHour) + 1;
      test.skip(
        !(perHour > 0) || hours > MAX_BOOKING_HOURS,
        `The wallet credit ($${walletBefore.toFixed(2)}) covers even a ${MAX_BOOKING_HOURS}-hr booking ` +
          `($${perHour.toFixed(2)}/hr), so Booking Details never shows "Have a gift card?"`,
      );
      const endIdx = sel.startIdx + hours * 4 - 1;
      const endTime = fromMinutes((endIdx + 1) * 15);
      const why = `the wallet's $${walletBefore.toFixed(2)} covers ${hoursNow} hr ($${perHour.toFixed(2)}/hr): End Time ${endTime} (${hours} hr)`;
      console.log(`[teetime-e2e] gift card: ${why}`);
      testInfo.annotations.push({ type: "booking-length", description: why });
      await app.guidedClick(modal.getByRole("combobox").nth(2)); // End Time
      await app.guidedClick(endTimeOption(app, endTime), { read: app.readMs });
      await expect(modal, "Booking Details shows the longer time").toContainText(`${sel.startTime} - ${endTime}`);
      sel = { ...sel, endIdx, endTime };
      await expect.poll(() => app.amountToPay(modal), { message: `"You pay" above $0 for ${hours} hr`, timeout: 10_000 }).toBeGreaterThan(0);
      before = await app.amountToPay(modal);
    }
    test.skip(
      before <= 0,
      `Nothing to pay ($${before.toFixed(2)}): the test user's wallet credit covers the booking, so Booking Details hides ` +
        `"Have a gift card?"`,
    );

    // The code to use: a popup in Booking Details asks you for it (the field starts empty: you type the code);
    // headless, nobody can answer, so TEETIME_GIFT_CARD_CODE is used as it is
    giftCode = headless ? env.giftCardCode : await askGiftCode(app, testInfo, modal);
    test.skip(!giftCode, "No gift card code entered in the popup");

    // "Have a gift card?" -> the code -> Apply ("You pay" goes down; a refused code skips with the app's reason)
    const { after } = await applyGiftCode(app, testInfo, modal, giftCode);
    // The booking time stays as selected (no End Time change): straight on to the waiver and Confirm
    const price = sessionPrice(await modal.innerText());
    // The wallet's credit is applied first, then the gift card, then the card pays what is left
    const walletPart = round2(Math.min(walletBefore, price));
    const giftPart = round2(price - walletPart - after);
    testInfo.annotations.push({
      type: "gift-card-payment",
      description:
        `${sel.startTime}–${sel.endTime} $${price.toFixed(2)}: wallet $${walletPart.toFixed(2)} + gift card $${giftPart.toFixed(2)} + ` +
        `card $${after.toFixed(2)}` + (after === 0 ? " (nothing left for the card)" : ""),
    });
    if (after === 0) {
      const warning =
        `the gift card covers the whole booking ($${price.toFixed(2)}): this run checks the gift card payment only, ` +
        "the card part is NOT tested.";
      testInfo.annotations.push({ type: "warning", description: warning });
      console.log(`[teetime-e2e] WARNING: ${warning}`);
    }
    await app.readPause();

    await app.scrollThrough(modal);
    await app.acceptWaiver(modal);
    if (after > 0) await orBlocked(testInfo, () => app.preparePayment(modal)); // the card pays the rest
    const bookingId = await app.confirmBooking(modal, { read: Math.min(1500, app.readMs) });
    testInfo.annotations.push({ type: "bookingId", description: bookingId });
    booking = { ...sel, bookingId, groupSize: 1 };
    suite.track(booking);
    await expectConfirmed(app, booking, { pause: false });
    await showBookingEmail(app, testInfo, booking, "confirmed");

    // How the booking was paid, as saved by the API
    const p = (await app.fetchBooking(bookingId))?.paymentBreakdown ?? {};
    testInfo.annotations.push({ type: "paymentBreakdown", description: JSON.stringify(p).slice(0, 300) });
    const gifts = (p.giftCards ?? []).reduce((sum: number, g: any) => sum + Number(g.amount || 0), 0);
    expect(Number(p.walletAmount || 0), "paid from the wallet (applied first)").toBeCloseTo(walletPart, 2);
    expect(gifts, "paid with the gift card").toBeCloseTo(giftPart, 2);
    expect(Number(p.cardAmount || 0), "paid by card").toBeCloseTo(after, 2);
    giftPaid = gifts;
  });

  test("TC113: View My Booking -> the gift-card booking is on the calendar", async () => {
    test.skip(!booking, "TC112 did not create the booking");
    await app.viewMyBooking(booking!);
  });

  test(`TC114: reschedule the gift-card booking -> its own time + ${RESCHEDULE_EXTRA_HOURS} hr more -> Booking Confirmed -> calendar`, async ({}, testInfo) => {
    test.skip(!booking, "TC112 did not create the booking");
    const b = booking!;
    // The new time: the booking's own time (same start) plus RESCHEDULE_EXTRA_HOURS right after it, in the same bay
    const startTime = b.startTime;
    const endTime = fromMinutes((b.endIdx + 1 + RESCHEDULE_EXTRA_HOURS * 4) * 15);
    testInfo.annotations.push({ type: "reschedule", description: `${b.startTime}–${b.endTime} -> ${startTime}–${endTime}` });
    await startReschedule(app, b);
    const next = await chooseNewTime(app, b, startTime, endTime); // same bay and group size, longer
    // Reschedule details: the longer time costs more — the gift card code pays the difference ("Have a gift card?"),
    // the card the rest, if any
    const gift = await confirmChangeDetails(app, testInfo, "reschedule", next, { pickGroupSize: true, giftCode }); // the code entered in TC112
    booking = next;
    rescheduled = true;

    // Saved: the gift card now paid more than at booking (it paid the reschedule difference too)
    const giftNow = round2(gift ? gift.before - gift.after : 0);
    const p = (await app.fetchBooking(next.bookingId))?.paymentBreakdown ?? {};
    const gifts = (p.giftCards ?? []).reduce((sum: number, g: any) => sum + Number(g.amount || 0), 0);
    testInfo.annotations.push({
      type: "reschedule-payment",
      description: `difference: gift card $${giftNow.toFixed(2)}; saved: ${JSON.stringify({ wallet: p.walletAmount, gift: p.giftCards, card: p.cardAmount })}`.slice(0, 300),
    });
    if (giftNow > 0) expect(round2(gifts), "gift card total = at booking + the reschedule difference").toBeCloseTo(round2(giftPaid + giftNow), 2);
    await app.viewMyBooking(booking); // every slot from the start to the new end belongs to the booking
  });

  test("TC115: cancel the gift-card booking -> refund shown and applied -> its slots free again", async ({}, testInfo) => {
    test.skip(!rescheduled, "TC114 did not reschedule the booking");
    await cancelInUi(app, testInfo, booking!, { checkRefund: true }); // policy, refund amount (gift card + card), applied
    suite.markCancelled();
    await expectBookingGone(app, booking!);
  });
});
