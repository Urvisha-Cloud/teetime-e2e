import type { BookingApp, CreatedBooking } from "../../support/booking-app";
import {
  bookFreeSlot,
  bookingSuite,
  clickAndExpectPatch,
  expectConfirmed,
  manageBooking,
  requireBookingCreation,
  rescheduleConfirmation,
  shiftedBy,
  showBookingEmail,
  slotsAfterRequested,
  slotsBeforeRequested,
} from "../helper";
import { expect, test } from "../fixtures";

/**
 * Main run, step 1 (card): TC7–12 quick shift from "Manage your booking": 15 min earlier / 15 min later (one booking
 * each, paid by card). Each booking is cancelled afterwards (TEETIME_CLEANUP=true).
 */

// ───────────────────────────── quick shift: 15 min earlier / later ─────────────────────────────

/** The backend needs time to finish moving the booking: stay on the Booking Confirmed screen this long before going on. */
const QUICK_SHIFT_SETTLE_MS = 1000;

for (const { minutes, label, first } of [
  { minutes: -15, label: "15 min earlier", first: 7 },
  { minutes: 15, label: "15 min later", first: 10 },
] as const) {
  test.describe(`Quick shift: ${label} @card-quick-shift @creates-booking`, () => {
    let app: BookingApp;
    const suite = bookingSuite((a) => (app = a), { watch: true });
    let original: CreatedBooking | undefined;
    let shifted: CreatedBooking | undefined;
    const shiftRoom = minutes < 0 ? slotsBeforeRequested(1) : slotsAfterRequested(1);

    test(`TC${first}: book the slot to move ${label}`, async ({}, testInfo) => {
      requireBookingCreation();
      // The 15 minutes the booking moves into must be free in the same bay too
      original = await bookFreeSlot(app, testInfo, { reuseOpenPage: true, alsoFree: shiftRoom }, { cardOnly: true });
      suite.track(original);
      await app.viewMyBooking(original, { highlight: false });
    });

    test(`TC${first + 1}: ⋮ -> "${label}" -> Reschedule booking shows current and new time -> Confirm changes -> Booking Confirmed`, async ({}, testInfo) => {
      test.skip(!original, `TC${first} did not create a booking`);
      // The 15 minutes must still be free right now (someone may have booked them since TC${first}). If not: cancel
      // this test booking, book another free slot that has the room, and shift that one — 3 tries at most.
      for (let attempt = 1; ; attempt++) {
        const room = minutes < 0 ? original!.startIdx - 1 : original!.endIdx + 1;
        const free = (await app.baysForRange(room, room)).find((x) => x.bayId === original!.bayId)?.free;
        if (free) break;
        if (attempt > 3) throw new Error(`The 15 minutes ${label} kept being taken by other bookings (3 new slots tried).`);
        console.log(`[teetime-e2e] the 15 min ${label} is no longer free for ${original!.startTime}–${original!.endTime}; booking another slot`);
        const res = await app.cancelBooking(original!.bookingId);
        console.log(`[teetime-e2e] cleanup: cancel ${original!.bookingId}: HTTP ${res.status}`);
        original = await bookFreeSlot(app, testInfo, { alsoFree: shiftRoom }, { cardOnly: true });
        suite.track(original);
        await app.viewMyBooking(original, { highlight: false });
      }
      const b = original!;
      const next = shiftedBy(b, minutes);

      // ⋮ on the booking -> "Manage your booking" -> Running early or late? -> 15 min earlier / later
      await manageBooking(app, b, label);

      // Confirmation: Current and New side by side, the new time 15 minutes earlier / later
      const confirm = await rescheduleConfirmation(app);
      for (const time of [b.startTime, b.endTime, next.startTime, next.endTime]) await expect(confirm).toContainText(time);
      await clickAndExpectPatch(app, testInfo, confirm.getByRole("button", { name: "Confirm Changes" }), "reschedule", b.bookingId);
      shifted = next;

      // Booking Checkout ("Booking Confirmed") with the new time -> straight to the shift email in YopMail (on top,
      // then behind) -> a short wait for the reschedule to settle before the next case
      await expectConfirmed(app, next, { pause: false });
      await showBookingEmail(app, testInfo, next, "rescheduled");
      await app.page.waitForTimeout(QUICK_SHIFT_SETTLE_MS);
    });

    test(`TC${first + 2}: View My Booking -> calendar shows the booking at the new time`, async () => {
      test.skip(!shifted, `TC${first + 1} did not move the booking`);
      const b = shifted!;
      // Calendar: bay, new time and players from the API + calendar cells; the old 15 minutes no longer belong to it
      await app.viewMyBooking(b, { highlight: false });
      const freed = minutes < 0 ? original!.endIdx : original!.startIdx;
      await app.expectNotOwnBooking(b.bayId, freed, freed);
      await app.highlightBooking(b);
    });
  });
}
