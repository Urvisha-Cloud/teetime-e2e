import type { BookingApp, CreatedBooking } from "../support/booking-app";
import { bookFreeSlot, bookingSuite, cancelInUi, expectBookingGone, requireBookingCreation } from "./helper";
import { test } from "./fixtures";

test.describe("Cancel a booking @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a));
  let booking: CreatedBooking | undefined;
  let cancelled = false;

  test("TC35: book a slot to cancel", async ({}, testInfo) => {
    requireBookingCreation();
    booking = await bookFreeSlot(app, testInfo);
    suite.track(booking);
    await app.viewMyBooking(booking, { highlight: false });
  });

  test("TC36: ⋮ menu -> Manage your booking -> Cancel booking -> Confirm cancellation", async ({}, testInfo) => {
    test.skip(!booking, "TC35 did not create a booking");
    await cancelInUi(app, testInfo, booking!);
    cancelled = true;
    suite.markCancelled(); // cancelled through the UI: nothing left to clean up
  });

  test("TC37: calendar no longer shows the cancelled booking", async () => {
    test.skip(!cancelled, "TC36 did not cancel the booking");
    await expectBookingGone(app, booking!);
  });
});
