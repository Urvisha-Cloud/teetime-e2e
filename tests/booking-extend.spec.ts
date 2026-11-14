import { BookingApp, type CreatedBooking } from "../support/booking-app";
import { env } from "../support/env";
import { fromMinutes, toMinutes } from "../support/time";
import { expect, orBlocked, requireBookingCreation, selectRequestedSlot, test } from "./fixtures";

/**
 * Test cases 38–41 — extend a booking through the calendar UI, one booking verified stage by stage:
 *
 *  TC38  book TEETIME_SLOT_START–END (default 8–9 PM tomorrow), back on the calendar
 *  TC39  booking's ⋮ button -> "Manage your booking" -> Extend Booking -> "Extend booking" popup
 *        -> quick pick TEETIME_EXTEND_BY (default "+30 min") -> "Ends <new end>" -> Continue
 *  TC40  "Extend details": waiver, payment for the extra time -> Confirm -> PATCH /booking/extend/:id succeeds
 *        -> "Booking Confirmed" screen with the NEW end time
 *  TC41  View My Booking -> calendar shows the booking up to the new end time (outlined)
 *
 * "Extend Booking" is only offered when the time right after the booking is free. Cancelled afterwards
 * (TEETIME_CLEANUP=true).
 */
test.describe("Extend a booking @creates-booking", () => {
  test.describe.configure({ mode: "serial" });

  let app: BookingApp;
  let original: CreatedBooking | undefined;
  let extended: CreatedBooking | undefined;
  const GROUP_SIZE = 1;

  /** "+30 min" -> 30, "+1 hr" -> 60 (the quick picks in the "Extend Booking" popup). */
  const extendMinutes = (() => {
    const m = env.extendBy.trim().match(/^\+(\d+)\s*(min|hr)$/i);
    if (!m) throw new Error(`TEETIME_EXTEND_BY="${env.extendBy}" must be one of "+30 min", "+1 hr", "+2 hr", "+3 hr"`);
    return Number(m[1]) * (m[2].toLowerCase() === "hr" ? 60 : 1);
  })();
  const extraSlots = extendMinutes / 15;

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

  test("TC38: book the slot to extend", async ({}, testInfo) => {
    requireBookingCreation();
    const sel = await selectRequestedSlot(app, testInfo);
    // The extra time right after the booking must be free in the same bay, or "Extend Booking" is not offered.
    const bays = await app.baysForRange(sel.endIdx + 1, sel.endIdx + extraSlots);
    if (!bays.find((b) => b.bayId === sel.bayId)?.free) {
      const why = `${sel.bayName} is not free for ${env.extendBy} after ${sel.endTime}`;
      testInfo.annotations.push({ type: "blocked", description: why });
      test.skip(true, why);
    }

    const modal = await app.openBookingModal(sel);
    await app.selectGroupSize(modal, GROUP_SIZE);
    await app.acceptWaiver(modal);
    await orBlocked(testInfo, () => app.preparePayment(modal));
    const bookingId = await app.confirmBooking(modal);
    original = { ...sel, bookingId, groupSize: GROUP_SIZE };
    testInfo.annotations.push({ type: "bookingId", description: bookingId });

    await app.page.getByRole("button", { name: "View My Booking" }).click();
    await app.waitForBookingUi();
    await app.goToDate(original.date);
    await app.verifyBookingOnCalendar(original);
  });

  test(`TC39: ⋮ menu -> Manage your booking -> Extend Booking -> ${env.extendBy} -> Continue`, async () => {
    test.skip(!original, "TC38 did not create a booking");
    const startCell = app.cell(original!.bayId, original!.startIdx);
    await startCell.scrollIntoViewIfNeeded();
    await startCell.getByRole("button").first().click(); // the ⋮ (more) button on the booking

    const update = dialog("Manage your booking");
    await expect(update).toBeVisible();
    await update.getByRole("button", { name: /Extend Booking/ }).click();

    const extend = dialog("additional time");
    await expect(extend).toBeVisible();
    await expect(extend.getByRole("heading", { name: "Extend Booking" })).toBeVisible();
    await extend.getByRole("button", { name: env.extendBy, exact: true }).click();

    const newEnd = fromMinutes(toMinutes(original!.endTime) + extendMinutes);
    await expect(extend, `"Ends ${newEnd}" after picking ${env.extendBy}`).toContainText(`Ends ${newEnd}`);
    await extend.getByRole("button", { name: /Continue/ }).click();
    await expect(extend).toBeHidden();

    extended = { ...original!, endIdx: original!.endIdx + extraSlots, endTime: newEnd };
  });

  test("TC40: Extend details -> waiver -> Confirm -> Booking Confirmed with the new end time", async ({}, testInfo) => {
    test.skip(!extended, "TC39 did not start the extension");
    const details = dialog("Extend details");
    await expect(details).toBeVisible({ timeout: 30_000 });

    // Pay for the extra time when "You pay" is above $0.00 (wallet / gift credit could cover it).
    const toPay = await app.amountToPay(details);
    testInfo.annotations.push({ type: "you-pay", description: `$${toPay.toFixed(2)}` });
    if (toPay > 0) await orBlocked(testInfo, () => app.preparePayment(details));
    // The waiver checkbox is at the bottom of the (scrolling) modal: scroll to it, tick it, then Confirm.
    await app.acceptWaiver(details);

    const responsePromise = app.page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().startsWith(env.apiURL) && r.url().includes(`/booking/extend/${extended!.bookingId}`),
      { timeout: 60_000 },
    );
    await details.getByRole("button", { name: /^Confirm/ }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    testInfo.annotations.push({ type: "extend-response", description: `HTTP ${response.status()} ${JSON.stringify(body).slice(0, 200)}` });
    expect(response.status(), `extend HTTP status (body: ${JSON.stringify(body).slice(0, 300)})`).toBeLessThan(400);

    await expect(app.page).toHaveURL(new RegExp(`/book-slot/success\\?bookingId=${extended!.bookingId}`), { timeout: 30_000 });
    await app.verifyCheckout(extended!); // "Booking Confirmed" with the original start and the NEW end time
    await app.page.waitForTimeout(env.showMs);
  });

  test("TC41: View My Booking -> calendar shows the booking up to the new end time", async () => {
    test.skip(!extended, "TC39 did not start the extension");
    await app.page.getByRole("button", { name: "View My Booking" }).click();
    await app.waitForBookingUi();
    await app.goToDate(extended!.date);
    await app.verifyBookingOnCalendar(extended!); // every slot from the start to the new end belongs to the booking

    // Show the extended booking before the browser moves on: scroll to it and outline it in green.
    await app.highlightBooking(extended!);
  });
});
