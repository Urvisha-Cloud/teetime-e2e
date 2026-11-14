import { BookingApp, type CreatedBooking } from "../support/booking-app";
import { env } from "../support/env";
import { expect, orBlocked, requireBookingCreation, selectRequestedSlot, test } from "./fixtures";

/**
 * Test cases 35–37 — cancel a booking through the calendar UI, one booking verified stage by stage:
 *
 *  TC35  book TEETIME_SLOT_START–END (default 8–9 PM tomorrow), back on the calendar
 *  TC36  booking's ⋮ button -> "Manage your booking" -> Cancel booking -> "Cancel booking" (refund policy)
 *        -> Confirm Cancellation -> PATCH /booking/cancel/:id succeeds -> "Booking cancelled"
 *  TC37  calendar: the booking is gone (not active for the user, its slots free again)
 *
 * If the run stops before TC36, the booking is cancelled afterwards (TEETIME_CLEANUP=true).
 */
test.describe("Cancel a booking @creates-booking", () => {
  test.describe.configure({ mode: "serial" });

  let app: BookingApp;
  let booking: CreatedBooking | undefined;
  let cancelled = false;
  const GROUP_SIZE = 1;

  test.beforeAll(async ({ sharedContext }) => {
    app = new BookingApp(sharedContext.pages()[0] ?? (await sharedContext.newPage()));
  });

  test.afterAll(async () => {
    // TC36 cancels the booking through the UI; only clean up if the run stopped before that.
    if (booking && env.cleanup && !cancelled) {
      const res = await app.cancelBooking(booking.bookingId);
      console.log(`[teetime-e2e] cleanup: cancel ${booking.bookingId}: HTTP ${res.status}`);
    }
    app?.api.detach();
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("failure.png", { body: await app.page.screenshot({ fullPage: true }), contentType: "image/png" });
    }
  });

  const dialog = (name: string | RegExp) => app.page.getByRole("dialog").filter({ hasText: name });

  test("TC35: book a slot to cancel", async ({}, testInfo) => {
    requireBookingCreation();
    const sel = await selectRequestedSlot(app, testInfo);
    const modal = await app.openBookingModal(sel);
    await app.selectGroupSize(modal, GROUP_SIZE);
    await app.acceptWaiver(modal);
    await orBlocked(testInfo, () => app.preparePayment(modal));
    const bookingId = await app.confirmBooking(modal);
    booking = { ...sel, bookingId, groupSize: GROUP_SIZE };
    testInfo.annotations.push({ type: "bookingId", description: bookingId });

    await app.page.getByRole("button", { name: "View My Booking" }).click();
    await app.waitForBookingUi();
    await app.goToDate(booking.date);
    await app.verifyBookingOnCalendar(booking);
  });

  test("TC36: ⋮ menu -> Manage your booking -> Cancel booking -> Confirm cancellation", async ({}, testInfo) => {
    test.skip(!booking, "TC35 did not create a booking");
    const startCell = app.cell(booking!.bayId, booking!.startIdx);
    await startCell.scrollIntoViewIfNeeded();
    await startCell.getByRole("button").first().click(); // the ⋮ (more) button on the booking

    const update = dialog("Manage your booking");
    await expect(update).toBeVisible();
    // "Cancel booking" is the red button in the modal's footer
    await update.getByRole("button", { name: "Cancel booking", exact: true }).click();

    const cancel = dialog("Confirm Cancellation");
    await expect(cancel).toBeVisible();
    await expect(cancel.getByRole("heading", { name: "Cancel Booking" })).toBeVisible();

    const responsePromise = app.page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().startsWith(env.apiURL) && r.url().includes(`/booking/cancel/${booking!.bookingId}`),
      { timeout: 60_000 },
    );
    await cancel.getByRole("button", { name: "Confirm Cancellation" }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    testInfo.annotations.push({ type: "cancel-response", description: `HTTP ${response.status()} ${JSON.stringify(body).slice(0, 200)}` });
    expect(response.status(), `cancel HTTP status (body: ${JSON.stringify(body).slice(0, 300)})`).toBeLessThan(400);
    await expect(app.page.getByText("Booking cancelled")).toBeVisible();
    await expect(cancel).toBeHidden();
    cancelled = true;
  });

  test("TC37: calendar no longer shows the cancelled booking", async () => {
    test.skip(!cancelled, "TC36 did not cancel the booking");
    await app.goToDate(booking!.date);
    // The booking is no longer active for this user...
    await expect
      .poll(async () => (await app.myActiveBookingIds()).includes(booking!.bookingId), {
        message: "cancelled booking still listed as active",
        timeout: 20_000,
      })
      .toBe(false);
    // ...and its slots on the calendar are free again (no booking styling, bay free for that time).
    await app.cell(booking!.bayId, booking!.startIdx).scrollIntoViewIfNeeded();
    for (let s = booking!.startIdx; s <= booking!.endIdx; s++) {
      await expect(app.cell(booking!.bayId, s)).not.toHaveClass(/before:border-green-600/);
    }
    const bays = await app.baysForRange(booking!.startIdx, booking!.endIdx);
    expect(bays.find((b) => b.bayId === booking!.bayId)?.free, `${booking!.bayName} is free again`).toBe(true);
    await app.page.waitForTimeout(env.showMs);
  });
});
