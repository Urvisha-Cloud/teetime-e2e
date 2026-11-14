import { BookingApp, type CreatedBooking } from "../support/booking-app";
import { env } from "../support/env";
import { fromMinutes, slotRange, toMinutes } from "../support/time";
import { expect, orBlocked, requireBookingCreation, selectRequestedSlot, test } from "./fixtures";

/**
 * Test cases 48–53 — "Running early or late?" in the "Manage your booking" modal: move a booking 15 minutes
 * earlier or later. One fresh booking per scenario (a booking can be moved only once):
 *
 *  15 min earlier                                   15 min later
 *  TC48  book TEETIME_SLOT_START–END (8–9 PM)        TC51  same
 *  TC49  ⋮ -> "15 min earlier" -> "Reschedule        TC52  ⋮ -> "15 min later" -> same checks with
 *        booking" shows Current (8:00–9:00 PM) and         New 8:15–9:15 PM
 *        New (7:45–8:45 PM) -> Confirm changes
 *        -> PATCH /booking/reschedule/:id
 *        -> Booking Confirmed with the new time
 *  TC50  View My Booking -> calendar at the new      TC53  same
 *        time -> My Booking page shows the new time
 *
 * Each booking is cancelled afterwards (TEETIME_CLEANUP=true).
 */
for (const { minutes, label, first } of [
  { minutes: -15, label: "15 min earlier", first: 48 },
  { minutes: 15, label: "15 min later", first: 51 },
]) {
  test.describe(`Quick shift: ${label} @creates-booking`, () => {
    test.describe.configure({ mode: "serial", timeout: 240_000 });

    let app: BookingApp;
    let original: CreatedBooking | undefined;
    let shifted: CreatedBooking | undefined;
    const GROUP_SIZE = 1;

    test.beforeAll(async ({ sharedContext }) => {
      app = new BookingApp(sharedContext.pages()[0] ?? (await sharedContext.newPage()));
    });

    test.afterAll(async () => {
      const booking = shifted ?? original;
      if (booking && env.cleanup) {
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

    test(`TC${first}: book the slot to move ${label}`, async ({}, testInfo) => {
      requireBookingCreation();
      // The 15 minutes the booking moves into must be free in the same bay too
      const { startIdx, endIdx } = slotRange(env.slotStart, env.slotEnd);
      const extra = minutes < 0 ? startIdx - 1 : endIdx + 1;
      const sel = await selectRequestedSlot(app, testInfo, [], {
        reuseOpenPage: true,
        tryNextDays: 7,
        alsoFree: { startIdx: extra, endIdx: extra },
      });

      const modal = await app.openBookingModal(sel);
      await app.readPause();
      await app.selectGroupSize(modal, GROUP_SIZE);
      await app.scrollThrough(modal);
      await app.acceptWaiver(modal);
      await orBlocked(testInfo, () => app.preparePayment(modal));
      const bookingId = await app.confirmBooking(modal, { read: Math.min(1500, env.readMs) });
      original = { ...sel, bookingId, groupSize: GROUP_SIZE };
      testInfo.annotations.push({ type: "bookingId", description: bookingId });

      await expect(app.page).toHaveURL(new RegExp(`/book-slot/success\\?bookingId=${bookingId}`), { timeout: 30_000 });
      await app.guidedClick(app.page.getByRole("button", { name: "View My Booking" }));
      await app.waitForBookingUi();
      await app.goToDate(original.date);
      await app.verifyBookingOnCalendar(original);
    });

    test(`TC${first + 1}: ⋮ -> "${label}" -> Reschedule booking shows current and new time -> Confirm changes -> Booking Confirmed`, async ({}, testInfo) => {
      test.skip(!original, `TC${first} did not create a booking`);
      const b = original!;
      const next: CreatedBooking = {
        ...b,
        startIdx: b.startIdx + minutes / 15,
        endIdx: b.endIdx + minutes / 15,
        startTime: fromMinutes(toMinutes(b.startTime) + minutes),
        endTime: fromMinutes(toMinutes(b.endTime) + minutes),
      };

      // ⋮ on the booking -> "Manage your booking" -> Running early or late? -> 15 min earlier / later
      const startCell = app.cell(b.bayId, b.startIdx);
      await startCell.scrollIntoViewIfNeeded();
      await app.guidedClick(startCell.getByRole("button").first());
      const menu = dialog("Manage your booking");
      await expect(menu).toBeVisible();
      const shiftButton = menu.getByRole("button", { name: label, exact: true });
      await expect(shiftButton, `"${label}" is available for a booking that was never moved`).toBeEnabled();
      await app.guidedClick(shiftButton, { read: env.readMs });

      // Confirmation: Current and New side by side, the new time 15 minutes earlier / later
      const confirm = dialog("Reschedule Booking");
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText("Current");
      await expect(confirm).toContainText(b.startTime);
      await expect(confirm).toContainText(b.endTime);
      await expect(confirm).toContainText("New");
      await expect(confirm).toContainText(next.startTime);
      await expect(confirm).toContainText(next.endTime);

      const responsePromise = app.page.waitForResponse(
        (r) => r.request().method() === "PATCH" && r.url().startsWith(env.apiURL) && r.url().includes(`/booking/reschedule/${b.bookingId}`),
        { timeout: 60_000 },
      );
      await app.guidedClick(confirm.getByRole("button", { name: "Confirm Changes" }), { read: env.readMs });
      const response = await responsePromise;
      const body = await response.json().catch(() => ({}));
      testInfo.annotations.push({ type: "reschedule-response", description: `HTTP ${response.status()} ${JSON.stringify(body).slice(0, 200)}` });
      expect(response.status(), `reschedule HTTP status (body: ${JSON.stringify(body).slice(0, 300)})`).toBeLessThan(400);
      shifted = next;

      // Booking Checkout ("Booking Confirmed") with the new time
      await expect(app.page).toHaveURL(new RegExp(`/book-slot/success\\?bookingId=${b.bookingId}`), { timeout: 30_000 });
      await app.verifyCheckout(next);
      await app.page.waitForTimeout(env.showMs);
    });

    test(`TC${first + 2}: View My Booking -> calendar and My Booking show the booking at the new time`, async () => {
      test.skip(!shifted, `TC${first + 1} did not move the booking`);
      const b = shifted!;
      await app.guidedClick(app.page.getByRole("button", { name: "View My Booking" }));
      await app.waitForBookingUi();
      await app.goToDate(b.date);
      await app.verifyBookingOnCalendar(b); // bay, new time and players from the API + calendar cells
      // The old 15 minutes no longer belong to the booking
      const freed = minutes < 0 ? original!.endIdx : original!.startIdx;
      await expect(app.cell(b.bayId, freed)).not.toHaveClass(/before:border-green-600/);
      await app.highlightBooking(b);

      // My Booking page: the booking card shows the new start time (cards use "hh:mm A", e.g. "07:45 PM")
      await app.guidedClick(app.page.getByText("My Booking", { exact: true }).first());
      await expect(app.page).toHaveURL(/\/my-bookings/);
      const newStart = b.startTime.replace(/^(\d):/, "0$1:");
      await expect(app.page.getByText(newStart).first(), `My Booking shows the new start ${newStart}`).toBeVisible({ timeout: 30_000 });
      await app.page.waitForTimeout(env.showMs);
    });
  });
}
