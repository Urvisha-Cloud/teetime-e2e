import type { TestInfo } from "@playwright/test";
import { BookingApp, type CreatedBooking } from "../support/booking-app";
import { env } from "../support/env";
import { slotRange } from "../support/time";
import { expect, orBlocked, requireBookingCreation, selectRequestedSlot, test } from "./fixtures";

/**
 * Test cases 27–34 — reschedule a booking, then update its group size, through the calendar UI.
 * One booking, verified stage by stage:
 *
 *  Reschedule
 *  TC27  book TEETIME_SLOT_START–END (default 8–9 PM tomorrow), back on the calendar
 *  TC28  booking's ⋮ button -> "Manage your booking" -> Reschedule -> "How to reschedule" -> Start rescheduling
 *  TC29  select the new time TEETIME_RESCHEDULE_START–END (default 9–11 PM, same bay) -> header "Reschedule"
 *        -> "Reschedule booking" confirmation (Current / New time) -> Confirm changes
 *  TC30  "Reschedule details": group size TEETIME_RESCHEDULE_GROUP_SIZE (default 4), waiver checkbox, payment if it
 *        costs more -> Confirm
 *        -> PATCH /booking/reschedule/:id succeeds -> "Booking Confirmed" screen with the NEW time
 *  TC31  View My Booking -> calendar shows the booking at the new time (outlined), not at the old time
 *
 *  Update group size (same booking)
 *  TC32  ⋮ -> "Manage your booking" -> Update Group Size -> "Update group size" -> TEETIME_GROUP_SIZE_UPDATE (default 5)
 *        -> Confirm & Add Players
 *  TC33  "Reschedule details" with the new group size -> waiver -> payment if it costs more -> Confirm
 *        -> "Booking Confirmed" with the new number of persons
 *  TC34  View My Booking -> calendar shows the booking with the new group size
 *
 * A booking can be rescheduled only once; every run books a fresh one. Cancelled afterwards (TEETIME_CLEANUP=true).
 * Cancelling through the UI is tested separately in booking-cancel.spec.ts.
 */
test.describe("Reschedule a booking and update its group size @creates-booking", () => {
  test.describe.configure({ mode: "serial" });

  let app: BookingApp;
  let original: CreatedBooking | undefined;
  let rescheduled: CreatedBooking | undefined;
  let resized: CreatedBooking | undefined;
  const GROUP_SIZE = 1;

  test.beforeAll(async ({ sharedContext }) => {
    app = new BookingApp(sharedContext.pages()[0] ?? (await sharedContext.newPage()));
  });

  test.afterAll(async () => {
    const booking = resized ?? rescheduled ?? original;
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

  /** Booking's ⋮ (more) button on the calendar -> the "Manage your booking" modal. */
  async function openUpdateMenu(booking: CreatedBooking) {
    const startCell = app.cell(booking.bayId, booking.startIdx);
    await startCell.scrollIntoViewIfNeeded();
    await startCell.getByRole("button").first().click();
    const update = dialog("Manage your booking");
    await expect(update).toBeVisible();
    return update;
  }

  /**
   * "Reschedule details" modal (used for both reschedule and group-size update): group size, waiver, payment if
   * the change costs more -> Confirm -> PATCH /booking/reschedule/:id -> "Booking Confirmed" for `booking`.
   */
  async function confirmRescheduleDetails(
    booking: CreatedBooking,
    testInfo: TestInfo,
    { pickGroupSize }: { pickGroupSize: boolean },
  ) {
    const details = dialog("Reschedule details");
    await expect(details).toBeVisible({ timeout: 30_000 });
    // Reschedule: the user picks the group size here. Group-size update: it is already selected by
    // "Confirm & Add Players", so the user only ticks the waiver and confirms.
    if (pickGroupSize) await app.selectGroupSize(details, booking.groupSize);
    await app.verifyGroupSize(details, booking.groupSize);
    // Pay the difference only when "You pay" is above $0.00. The saved card ("Use Different Card") is shown even when
    // nothing is due (e.g. "Previously paid" covers the change), so its presence does not mean a card is needed.
    const toPay = await app.amountToPay(details);
    testInfo.annotations.push({ type: "you-pay", description: `$${toPay.toFixed(2)}` });
    if (toPay > 0) await orBlocked(testInfo, () => app.preparePayment(details));
    // The waiver checkbox is at the bottom of the (scrolling) modal: scroll to it, tick it, then Confirm.
    await app.acceptWaiver(details);

    const responsePromise = app.page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().startsWith(env.apiURL) && r.url().includes(`/booking/reschedule/${booking.bookingId}`),
      { timeout: 60_000 },
    );
    await details.getByRole("button", { name: /^Confirm/ }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    testInfo.annotations.push({ type: "reschedule-response", description: `HTTP ${response.status()} ${JSON.stringify(body).slice(0, 200)}` });
    expect(response.status(), `reschedule HTTP status (body: ${JSON.stringify(body).slice(0, 300)})`).toBeLessThan(400);

    await expect(app.page).toHaveURL(new RegExp(`/book-slot/success\\?bookingId=${booking.bookingId}`), { timeout: 30_000 });
    await app.verifyCheckout(booking); // "Booking Confirmed": time range and number of persons
    await app.page.waitForTimeout(env.showMs);
  }

  /** View My Booking -> calendar on the booking's date -> booking verified there, outlined in green for a moment. */
  async function showOnCalendar(booking: CreatedBooking) {
    await app.page.getByRole("button", { name: "View My Booking" }).click();
    await app.waitForBookingUi();
    await app.goToDate(booking.date);
    await app.verifyBookingOnCalendar(booking); // bay, time and number of persons from the API + calendar cells
    await app.cell(booking.bayId, booking.startIdx).scrollIntoViewIfNeeded();
    for (let s = booking.startIdx; s <= booking.endIdx; s++) {
      await app.cell(booking.bayId, s).evaluate((el) => {
        (el as HTMLElement).style.outline = "3px solid #16a34a";
        (el as HTMLElement).style.outlineOffset = "-3px";
      });
    }
    await app.page.waitForTimeout(env.showMs);
  }

  // ───────────────────────────── reschedule ─────────────────────────────

  test("TC27: book the original slot", async ({}, testInfo) => {
    requireBookingCreation();
    const sel = await selectRequestedSlot(app, testInfo);
    // The new time must also be free in the same bay, or the reschedule cannot be tested.
    const { startIdx, endIdx } = slotRange(env.rescheduleStart, env.rescheduleEnd);
    const bays = await app.baysForRange(startIdx, endIdx);
    if (!bays.find((b) => b.bayId === sel.bayId)?.free) {
      testInfo.annotations.push({ type: "blocked", description: `${sel.bayName} is not free ${env.rescheduleStart}–${env.rescheduleEnd}` });
      test.skip(true, `${sel.bayName} is not free ${env.rescheduleStart}–${env.rescheduleEnd}`);
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

  test("TC28: ⋮ menu -> Manage your booking -> Reschedule -> Start rescheduling", async () => {
    test.skip(!original, "TC27 did not create a booking");
    const update = await openUpdateMenu(original!);
    await update.getByRole("button", { name: /Reschedule/ }).filter({ hasText: "Choose a new time" }).click();

    const rules = dialog("How to Reschedule");
    await expect(rules).toBeVisible();
    await expect(rules).toContainText(/only once/i);
    await rules.getByRole("button", { name: /Start rescheduling/i }).click();
    await expect(rules).toBeHidden();
    // Reschedule mode: the booking now shows its "Cancel Reschedule" button.
    await expect(app.cell(original!.bayId, original!.startIdx).getByTitle("Cancel Reschedule")).toBeVisible();
  });

  test("TC29: select the new time -> Reschedule -> confirmation -> Confirm Changes", async () => {
    test.skip(!original, "TC27 did not create a booking");
    const { startIdx, endIdx } = slotRange(env.rescheduleStart, env.rescheduleEnd);
    const bayId = original!.bayId;
    await app.cell(bayId, startIdx).scrollIntoViewIfNeeded();
    await app.cell(bayId, startIdx).click({ position: { x: 12, y: 12 } });
    await app.cell(bayId, endIdx).click({ position: { x: 12, y: 12 } });
    for (let s = startIdx; s <= endIdx; s++) await expect(app.cell(bayId, s)).toHaveClass(/bg-green-400\/50/);

    await app.page.getByRole("button", { name: "Reschedule", exact: true }).click();
    const confirm = dialog("Reschedule Booking");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Current");
    await expect(confirm).toContainText("New");
    await confirm.getByRole("button", { name: "Confirm Changes" }).click();
    await expect(confirm).toBeHidden();

    // In "Reschedule details" (TC30) the group size is changed too, to TEETIME_RESCHEDULE_GROUP_SIZE.
    rescheduled = {
      ...original!,
      startIdx,
      endIdx,
      startTime: env.rescheduleStart,
      endTime: env.rescheduleEnd,
      groupSize: env.rescheduleGroupSize,
    };
  });

  test(`TC30: Reschedule details -> group size ${env.rescheduleGroupSize} -> waiver -> Confirm -> Booking Confirmed with the new time and size`, async ({}, testInfo) => {
    test.skip(!rescheduled, "TC29 did not start the reschedule");
    await confirmRescheduleDetails(rescheduled!, testInfo, { pickGroupSize: true });
  });

  test("TC31: View My Booking -> calendar shows the booking at the new time", async () => {
    test.skip(!rescheduled, "TC29 did not start the reschedule");
    await showOnCalendar(rescheduled!);
    // The old time no longer belongs to this booking (unless it overlaps the new range).
    for (let s = original!.startIdx; s <= original!.endIdx; s++) {
      if (s >= rescheduled!.startIdx && s <= rescheduled!.endIdx) continue;
      await expect(app.cell(rescheduled!.bayId, s)).not.toHaveClass(/before:border-green-600/);
    }
  });

  // ───────────────────────────── update group size ─────────────────────────────

  test("TC32: ⋮ menu -> Manage your booking -> Update Group Size -> select size -> Add players", async () => {
    test.skip(!rescheduled, "TC29 did not start the reschedule");
    const newSize = env.groupSizeUpdate;
    expect(newSize, "TEETIME_GROUP_SIZE_UPDATE must be larger than the booked group size (players can only be added)")
      .toBeGreaterThan(rescheduled!.groupSize);

    const update = await openUpdateMenu(rescheduled!);
    await update.getByRole("button", { name: /Update Group Size/ }).click();

    // Identify the popup by its own label: the "Reschedule details" modal that opens next has its own group size buttons.
    const picker = dialog("Choose Number of Persons");
    await expect(picker).toBeVisible();
    // The count can only go up: sizes BELOW the current one are disabled; the current size stays selectable
    // (it is pre-selected), and "Add players" stays disabled until a larger size is picked.
    const current = rescheduled!.groupSize;
    for (let n = 1; n < current; n++) {
      await expect(picker.getByRole("button", { name: String(n), exact: true })).toBeDisabled();
    }
    const confirm = picker.getByRole("button", { name: /^Add players/ });
    await expect(confirm, "disabled while the current group size is selected").toBeDisabled();
    await picker.getByRole("button", { name: String(newSize), exact: true }).click();
    await expect(confirm, "enabled after picking a larger group size").toBeEnabled();
    await confirm.click();
    await expect(picker).toBeHidden();
    await expect(dialog("Reschedule details"), "booking modal opens after Add players").toBeVisible({ timeout: 30_000 });

    resized = { ...rescheduled!, groupSize: newSize };
  });

  test("TC33: Reschedule details with the new group size -> waiver -> Confirm -> Booking Confirmed", async ({}, testInfo) => {
    test.skip(!resized, "TC32 did not start the group size update");
    await confirmRescheduleDetails(resized!, testInfo, { pickGroupSize: false });
  });

  test("TC34: View My Booking -> calendar shows the booking with the new group size", async () => {
    test.skip(!resized, "TC32 did not start the group size update");
    await showOnCalendar(resized!); // also checks numberOfPersons from the API
  });
});
