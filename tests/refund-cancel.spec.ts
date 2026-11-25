import type { BookingApp, CreatedBooking } from "../support/booking-app";
import { bookFreeSlot, bookingSuite, cancelInUi, expectBookingGone, requireBookingCreation, selectRequestedSlot } from "./helper";
import { test } from "./fixtures";

/**
 * Cancellation refund policy, one booking per row of REFUND_CASES (TC81–89 …): book a slot that starts at the right
 * time, check the refund the cancel popup shows (policy list, amount or "non-refundable"), Confirm cancellation
 * and check the refund the backend applied and that the booking is gone.
 *
 * Its own file so `npm test` runs these LAST (Playwright runs files alphabetically): after the booking flow and the
 * quick-shift cases come the 50% and the no-refund case. `npm run test:cancel` runs all of them with TC35–37.
 */

// ───────────────────────────── refund policy ─────────────────────────────
// One row per cancellation scenario. Each row gets three tests: book a slot that starts at the right time; check the
// refund the cancel popup shows (policy list, amount or "non-refundable") and Confirm cancellation straight away, with
// the refund the backend applied checked too; check the booking is gone. To add a case, add a row (the booking time
// comes from `slot`: selectRequestedSlot options).
const REFUND_CASES: {
  name: string;
  /** Refund percent the popup must show (REFUND_TIERS). */
  percent: number;
  /** Where to book it; todayWindow keeps the start inside one tier with room to spare at both ends. */
  slot: Parameters<typeof selectRequestedSlot>[3];
}[] = [
  { name: "more than 4 hours before the start: 90% refund", percent: 90, slot: {} },
  { name: "1–4 hours before the start: 50% refund", percent: 50, slot: { tryNextDays: 0, todayWindow: { min: 80, max: 220 } } },
  { name: "within 1 hour of the start: no refund", percent: 0, slot: { tryNextDays: 0, todayWindow: { min: 15, max: 45 } } },
];

REFUND_CASES.forEach((c, i) => {
  const first = 81 + i * 3; // TC81–83, TC84–86, TC87–89, …
  test.describe(`Cancel — ${c.name}${c.percent < 90 ? " @main" : ""} @creates-booking`, () => {
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
});
