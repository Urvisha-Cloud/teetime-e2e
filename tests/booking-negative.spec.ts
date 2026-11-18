import { env } from "../support/env";
import { blockBookingCreation, failBookingCreation, fakeBookingSuccess, toast } from "../support/guards";
import { slotRange, todayIn } from "../support/time";
import { fillBookingModal, orBlocked, selectRequestedSlot } from "./helper";
import { expect, test } from "./fixtures";

test.describe("Unavailable slots and failures", () => {
  test("TC15: unavailable time slots cannot be selected or booked", async ({ app, page }, testInfo) => {
    await blockBookingCreation(page);
    await app.open();
    await app.selectLocation(env.locationName);

    // (a) Past slot today — 12:00 AM is always in the past (CalenderGrid isSlotInPast -> "cursor-not-allowed bg-black/5").
    await orBlocked(testInfo, () => app.goToDate(todayIn(app.tz)));
    const bays = await app.baysForRange(0, 0);
    const pastCell = app.cell(bays[0].bayId, 0);
    await expect(pastCell).toHaveClass(/cursor-not-allowed/);
    await pastCell.click({ position: { x: 12, y: 12 }, force: true });
    await expect(pastCell).not.toHaveClass(/bg-green-400\/50/);
    await expect(app.bookNowButton()).toHaveCount(0);

    // (b) A slot already booked by someone else on the booking date, if any exists in staging data.
    const date = app.targetDate();
    await orBlocked(testInfo, () => app.goToDate(date));
    const taken = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll<HTMLElement>("[data-slot][data-screen]"));
      const c = cells.find((el) => el.className.includes("before:border-gray-600")); // other users' bookings
      return c ? { bayId: c.getAttribute("data-screen")!, slot: Number(c.getAttribute("data-slot")) } : null;
    });
    if (taken) {
      const cell = app.cell(taken.bayId, taken.slot);
      await cell.scrollIntoViewIfNeeded();
      await cell.click({ position: { x: 12, y: 12 }, force: true });
      await expect(cell).not.toHaveClass(/bg-green-400\/50/);
      await expect(app.bookNowButton()).toHaveCount(0);
    } else {
      testInfo.annotations.push({ type: "info", description: "No other-user booking on the booking date; part (b) not exercised." });
    }

    // (c) The booking time in use (if a test picked one): report which bays are free for it.
    if (env.slotStart) {
      const { startIdx: s, endIdx: e } = slotRange(env.slotStart, env.slotEnd);
      const state = await app.baysForRange(s, e);
      testInfo.annotations.push({
        type: "availability",
        description: `${env.slotStart}–${env.slotEnd}: ${state.map((b) => `${b.bayName}=${b.free ? "free" : "taken"}`).join(", ")}`,
      });
    }
    expect(app.api.createRequests.length).toBe(0);
  });

  for (const scenario of [
    { name: "HTTP 500 from the API", status: 500, body: { success: false, message: "E2E simulated server error" }, expectText: "E2E simulated server error" },
    { name: "success:false from the API", status: 200, body: { success: false, message: "E2E simulated slot conflict" }, expectText: "E2E simulated slot conflict" },
  ]) {
    test(`TC16: booking creation failure is reported to the user (${scenario.name})`, async ({ app, page }, testInfo) => {
      // The request is answered by Playwright; nothing reaches staging and no booking is created.
      await failBookingCreation(page, scenario.status, scenario.body);
      const sel = await selectRequestedSlot(app, testInfo);
      const modal = await fillBookingModal(app, testInfo, sel); // group size 1, waiver, payment
      await app.confirmButton(modal).click();

      await expect(toast(page, scenario.expectText)).toBeVisible();
      await expect.poll(() => app.api.createRequests.length).toBe(1);
      // User stays on the booking modal with their input intact; no redirect to the success page.
      await expect(page).toHaveURL(/\/book-now$/);
      await expect(modal).toBeVisible();
      await app.verifyGroupSize(modal, 1);
      await expect(app.waiverCheckbox(modal)).toBeChecked();
      await expect(page.getByRole("heading", { name: "Booking Confirmed" })).toHaveCount(0);
    });
  }

  test("TC17: double-clicking Confirm sends only one create request", async ({ app, page }, testInfo) => {
    // KNOWN BOOKING-SITE BUG: the double-click currently sends two create requests. Marked as an expected
    // failure so the run keeps its single Chrome window (an unexpected failure restarts the browser).
    // When the bug is fixed this test "unexpectedly passes" — then remove this line.
    test.fail(true, "Known bug: Confirm is not disabled after the first click, so a double-click sends 2 create requests");
    // The create call is answered by Playwright with a simulated success: nothing reaches staging,
    // nothing is booked or charged. The test only counts how many create requests the double-click sends.
    const FAKE_BOOKING_ID = "00000000-0000-4000-8000-000000000017";
    const posts = await fakeBookingSuccess(page, FAKE_BOOKING_ID);
    const sel = await selectRequestedSlot(app, testInfo);
    const modal = await fillBookingModal(app, testInfo, sel, { groupSize: 2 });

    const confirm = app.confirmButton(modal);
    await confirm.scrollIntoViewIfNeeded();
    // Note: the Confirm button's `disabled` prop is commented out in BookingModal.tsx; the only guard is the
    // "Booking in progress..." overlay. This test checks the user-visible outcome.
    await confirm.dblclick();
    await page.waitForURL(/\/book-slot\/success\?bookingId=/, { timeout: 60_000 });
    await page.waitForTimeout(1_000); // let a late second request arrive before counting

    testInfo.annotations.push({ type: "create-requests", description: String(posts.length) });
    expect(posts.length, "Confirm double-click sent more than one create request").toBe(1);
  });
});
