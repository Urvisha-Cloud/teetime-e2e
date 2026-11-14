import { BookingApp, type CreatedBooking } from "../support/booking-app";
import { env } from "../support/env";
import { slotRange } from "../support/time";
import { exerciseExtendControls, extendEndLabel, formatMinutes } from "../support/extend-popup";
import { expect, orBlocked, requireBookingCreation, selectRequestedSlot, test } from "./fixtures";

/**
 * Test cases 54–57 — the three ways to pick extra time in the "Extend booking" popup, on one booking:
 *
 *  TC54  book TEETIME_SLOT_START–END (8–9 PM); the 3 hours after it must be free in that bay (the popup's maximum)
 *  TC55  ⋮ -> Extend Booking -> every control drives the same value, and the readout ("+45 min"), the slider and
 *        "Ends <time>" (original end + extra time) always agree:
 *          starts at +15 min with "−" disabled · "+" ×3 -> +1 hr · "−" -> +45 min · presets +30 min / +1 hr / +2 hr /
 *          +3 hr (max: "+" disabled; 9 PM + 3 hr = "Ends 12:00 AM", past midnight) · "−" down to the minimum ·
 *          drag the slider to +45 min -> Continue   (same checks as the main flow's TC46, support/extend-popup.ts)
 *  TC56  "Extend details" -> waiver -> Confirm -> PATCH /booking/extend/:id -> Booking Confirmed with the new end time
 *  TC57  View My Booking -> calendar shows the booking up to the new end -> My Booking page shows the new end time
 *
 * Cancelled afterwards (TEETIME_CLEANUP=true).
 */
test.describe("Extend booking: slider, + / − and presets @creates-booking", () => {
  test.describe.configure({ mode: "serial", timeout: 240_000 });

  let app: BookingApp;
  let original: CreatedBooking | undefined;
  let extended: CreatedBooking | undefined;
  const GROUP_SIZE = 1;
  const MAX_SLOTS = 12; // the popup offers up to 3 hours (12 × 15 min) when that time is free
  const PICK_SLOTS = 3; // final choice: +45 min (as in the screenshots)

  test.beforeAll(async ({ sharedContext }) => {
    app = new BookingApp(sharedContext.pages()[0] ?? (await sharedContext.newPage()));
  });

  test.afterAll(async () => {
    const booking = extended ?? original;
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

  test("TC54: book the slot to extend (3 hours after it free)", async ({}, testInfo) => {
    requireBookingCreation();
    // The popup's maximum (3 hr) is only offered when that time after the booking is free in the same bay
    const { endIdx: e } = slotRange(env.slotStart, env.slotEnd);
    const sel = await selectRequestedSlot(app, testInfo, [], {
      reuseOpenPage: true,
      tryNextDays: 7,
      alsoFree: { startIdx: e + 1, endIdx: Math.min(95, e + MAX_SLOTS) },
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

  test("TC55: slider, + / − and presets all drive one value; limits and end time (incl. past midnight)", async ({}, testInfo) => {
    test.skip(!original, "TC54 did not create a booking");
    const b = original!;
    const startCell = app.cell(b.bayId, b.startIdx);
    await startCell.scrollIntoViewIfNeeded();
    await app.guidedClick(startCell.getByRole("button").first());
    const menu = dialog("Manage your booking");
    await expect(menu).toBeVisible();
    await app.guidedClick(menu.getByRole("button", { name: /Extend Booking/ }), { read: env.readMs });

    const popup = dialog("additional time");
    await expect(popup).toBeVisible();
    const max = await exerciseExtendControls(app, popup, b, PICK_SLOTS);
    testInfo.annotations.push({ type: "max", description: `${max} slots (${formatMinutes(max * 15)})` });
    expect(max, "3 hours were checked free, so the popup offers up to 3 hr").toBe(MAX_SLOTS);

    const newEnd = extendEndLabel(b, PICK_SLOTS);
    await app.guidedClick(popup.getByRole("button", { name: /Continue/ }), { read: env.readMs });
    await expect(popup).toBeHidden();
    extended = { ...b, endIdx: b.endIdx + PICK_SLOTS, endTime: newEnd };
  });

  test("TC56: Extend details -> waiver -> Confirm -> Booking Confirmed with the new end time", async ({}, testInfo) => {
    test.skip(!extended, "TC55 did not pick the extra time");
    const details = dialog("Extend details");
    await expect(details).toBeVisible({ timeout: 30_000 });
    await expect(details, "new time range in the details").toContainText(`${extended!.startTime} - ${extended!.endTime}`);
    await app.readPause();
    await app.scrollThrough(details);
    const toPay = await app.amountToPay(details);
    testInfo.annotations.push({ type: "you-pay", description: `$${toPay.toFixed(2)}` });
    if (toPay > 0) await orBlocked(testInfo, () => app.preparePayment(details));
    await app.acceptWaiver(details);

    const responsePromise = app.page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().startsWith(env.apiURL) && r.url().includes(`/booking/extend/${extended!.bookingId}`),
      { timeout: 60_000 },
    );
    await app.guidedClick(details.getByRole("button", { name: /^Confirm/ }), { read: Math.min(1500, env.readMs) });
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    testInfo.annotations.push({ type: "extend-response", description: `HTTP ${response.status()} ${JSON.stringify(body).slice(0, 200)}` });
    expect(response.status(), `extend HTTP status (body: ${JSON.stringify(body).slice(0, 300)})`).toBeLessThan(400);

    await expect(app.page).toHaveURL(new RegExp(`/book-slot/success\\?bookingId=${extended!.bookingId}`), { timeout: 30_000 });
    await app.verifyCheckout(extended!); // same start, NEW end time, same group size
    await app.page.waitForTimeout(env.showMs);
  });

  test("TC57: View My Booking -> calendar and My Booking show the booking up to the new end time", async () => {
    test.skip(!extended, "TC55 did not pick the extra time");
    const b = extended!;
    await app.guidedClick(app.page.getByRole("button", { name: "View My Booking" }));
    await app.waitForBookingUi();
    await app.goToDate(b.date);
    await app.verifyBookingOnCalendar(b); // every slot from the start to the new end belongs to the booking
    await app.highlightBooking(b);

    // My Booking card shows the new end time ("hh:mm A", e.g. "09:45 PM")
    await app.guidedClick(app.page.getByText("My Booking", { exact: true }).first());
    await expect(app.page).toHaveURL(/\/my-bookings/);
    const newEnd = b.endTime.replace(/^(\d):/, "0$1:");
    await expect(app.page.getByText(newEnd).first(), `My Booking shows the new end ${newEnd}`).toBeVisible({ timeout: 30_000 });
    await app.page.waitForTimeout(env.showMs);
  });
});
