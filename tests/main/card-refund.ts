import type { BookingApp, CreatedBooking } from "../../support/booking-app";
import { bookFreeSlot, bookingSuite, cancelInUi, expectBookingGone, requireBookingCreation, selectRequestedSlot } from "../helper";
import { test } from "../fixtures";

/**
 * Main run, step 1 (card): cancel a booking starting 1–4 hours from now -> 50% refund, and one starting within 1 hour
 * -> no refund. Each checks the popup, confirms the cancellation straight away, then checks the refund the backend
 * applied and that the booking is gone (each skips itself when no such time is free today).
 */

// ───────────────────────────── refund policy ─────────────────────────────
// One RefundCase per cancellation scenario; refundCancelSuite() gives it three tests: book a slot that starts at the
// right time; check the refund the cancel popup shows (policy list, amount or "non-refundable") and Confirm
// cancellation straight away, with the refund the backend applied checked too; check the booking is gone. To add a
// case, add a RefundCase with its own TC numbers and call refundCancelSuite() below.
type RefundCase = {
  /** Its first test case number: TC<first> book, TC<first + 1> cancel, TC<first + 2> gone from the calendar. */
  first: number;
  name: string;
  /** Refund percent the popup must show (REFUND_TIERS). */
  percent: number;
  /** Where to book it; todayWindow keeps the start inside one tier with room to spare at both ends. */
  slot: Parameters<typeof selectRequestedSlot>[3];
};

const REFUND_50: RefundCase = {
  first: 13,
  name: "1–4 hours before the start: 50% refund",
  percent: 50,
  slot: { tryNextDays: 0, todayWindow: { min: 80, max: 220 } },
};
const REFUND_NONE: RefundCase = {
  first: 16,
  name: "within 1 hour of the start: no refund",
  percent: 0,
  slot: { tryNextDays: 0, todayWindow: { min: 15, max: 45 } },
};

/** Three tests for one refund case: book a slot that starts at the right time -> cancel (popup + applied refund) -> gone. */
function refundCancelSuite(c: RefundCase) {
  const { first } = c;
  test.describe(`Cancel — ${c.name} @card-refund @creates-booking`, () => {
    let app: BookingApp;
    const suite = bookingSuite((a) => (app = a), { watch: true });
    let booking: CreatedBooking | undefined;

    test(`TC${first}: book a slot (${c.name})`, async ({}, testInfo) => {
      requireBookingCreation();
      booking = await bookFreeSlot(app, testInfo, { reuseOpenPage: true, ...c.slot }, { cardOnly: true }); // skipped if no such time is free
      suite.track(booking);
      await app.viewMyBooking(booking, { highlight: false });
    });

    let cancelled = false;

    test(`TC${first + 1}: cancel popup shows the policy and a ${c.percent}% refund -> Confirm cancellation -> refund applied`, async ({}, testInfo) => {
      test.skip(!booking, `TC${first} did not create a booking`);
      // Policy list + refund in the popup (this tier), then Confirm cancellation straight away; the refund the backend
      // applied must be the same
      await cancelInUi(app, testInfo, booking!, { expectPercent: c.percent });
      cancelled = true;
      suite.markCancelled(); // cancelled through the app: nothing left to clean up
    });

    test(`TC${first + 2}: the cancelled booking is gone from the calendar`, async () => {
      test.skip(!cancelled, `TC${first + 1} did not cancel the booking`);
      await expectBookingGone(app, booking!);
    });
  });
}

refundCancelSuite(REFUND_50);
refundCancelSuite(REFUND_NONE);
