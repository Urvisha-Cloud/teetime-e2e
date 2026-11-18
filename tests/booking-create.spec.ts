import type { BookingApp, CreatedBooking } from "../support/booking-app";
import { env } from "../support/env";
import { bookingSuite, bookSlot, requireBookingCreation, selectRequestedSlot } from "./helper";
import { expect, test } from "./fixtures";

/**
 * Test cases 11–14 — the ONLY real booking the suite creates per run, verified stage by stage.
 * Serial + one shared page so the four cases describe a single booking instead of creating four.
 * Uses the run-wide shared Chrome window (see `sharedContext` in fixtures.ts), so no extra window opens.
 */
test.describe("Booking journey: confirm → confirmation screen → View My Booking @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a));
  let booking: CreatedBooking | undefined;
  const GROUP_SIZE = 3;

  test("TC11: Confirm Booking creates the booking", async ({}, testInfo) => {
    requireBookingCreation();
    const sel = await selectRequestedSlot(app, testInfo);
    const before = app.api.createRequests.length;
    // Group size, waiver (the checkbox only; the waiver page is not opened), payment -> Confirm
    // (asserts HTTP < 400, success=true, bookingId and the redirect)
    booking = await bookSlot(app, testInfo, sel, { groupSize: GROUP_SIZE });
    suite.track(booking);
    expect(app.api.createRequests.length - before, "exactly one create request").toBe(1);
    const sent = app.api.createRequests.at(-1)!.postDataJSON();
    expect(sent.numberOfPersons).toBe(GROUP_SIZE);
    expect(sent.bayId).toBe(sel.bayId);
  });

  test("TC12: confirmation (checkout) screen shows the booking details", async () => {
    test.skip(!booking, "TC11 did not create a booking");
    // This screen is a post-payment confirmation, not a payment form: it never asks for card details.
    await expect(app.page).toHaveURL(/\/book-slot\/success\?bookingId=/);
    const fromApi = await app.verifyCheckout(booking!);
    await expect(app.page.getByText(/Card Number|Pay now/i)).toHaveCount(0);
    if (fromApi) test.info().annotations.push({ type: "status", description: `isCancelled=${fromApi.isCancelled} paidAmount=${fromApi.paidAmount}` });
    // Keep the confirmation screen on screen for a moment (useful with --headed).
    await app.page.getByRole("heading", { name: "Booking Confirmed" }).scrollIntoViewIfNeeded();
    await app.page.waitForTimeout(env.showMs);
  });

  test("TC13: View My Booking returns to the booking calendar", async () => {
    test.skip(!booking, "TC11 did not create a booking");
    const returnTo = new URL(app.page.url()).searchParams.get("returnTo");
    expect(returnTo, "returnTo is the page the booking was made from").toBe("/book-now");
    await app.page.getByRole("button", { name: "View My Booking" }).click();
    await expect(app.page).toHaveURL(/\/book-now$/);
    await app.waitForBookingUi();
    await expect(app.locationButton()).toContainText(booking!.locationName);
  });

  test("TC14: the new booking is visible on the calendar after returning", async () => {
    test.skip(!booking, "TC11 did not create a booking");
    await app.goToDate(booking!.date);
    await app.verifyBookingOnCalendar(booking!);
    // Detail match with the confirmation screen: the start cell shows the owner's name, not a time range.
    const startCell = app.cell(booking!.bayId, booking!.startIdx);
    await expect(startCell).not.toHaveText(/AM|PM/);

    // Show the booked slots on the calendar before the browser closes: scroll to them and outline them in green.
    await app.highlightBooking(booking!);
  });
});
