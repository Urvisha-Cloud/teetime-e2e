import type { BookingApp, CreatedBooking } from "../support/booking-app";
import { env } from "../support/env";
import { toast } from "../support/guards";
import { addDays, fromMinutes, isoDate } from "../support/time";
import {
  atTime,
  bookFreeSlot,
  bookingSuite,
  chooseNewTime,
  confirmChangeDetails,
  fillBookingModal,
  manageBooking,
  orBlocked,
  requireBookingCreation,
  rescheduleConfirmation,
  rescheduleSlotsRange,
  slotsAfterRequested,
  startReschedule,
} from "./helper";
import { expect, test } from "./fixtures";

/**
 * Reschedule rules and edge cases on the customer side (the happy paths are in booking-reschedule.spec.ts and the
 * booking flow). Each describe uses its own fresh booking at the first free time. Everything is checked on the
 * Book Now calendar (/book-now); the tests never open the My Booking tab.
 *
 *  Only once            TC62 book · TC63 reschedule -> calendar shows the new time · TC64 Reschedule and both
 *                       15-min shifts are disabled afterwards
 *  Leave unchanged      TC65 book · TC66 "How to reschedule" -> Back: not in reschedule mode · TC67 reschedule mode:
 *                       other bays disabled, a shorter new time is refused, "Cancel Reschedule" (X) leaves it ·
 *                       TC68 confirmation -> Cancel · TC69 "Reschedule details" closed · TC70 group size picker offers
 *                       exactly the bay's maximum — after each, the booking is unchanged
 *  Another date         TC71 book · TC72 reschedule to the next day in the same bay -> calendar
 *  Within 4 hours       TC73 book today, starting within 4 hours · TC74 Reschedule disabled ("Not available within 4
 *                       hours of start"), the 15-min shifts still offered
 *  Conflicts            TC75 book A and B right after it, same bay · TC76 "15 min later" on A -> "already booked",
 *                       no change · TC77 reschedule A onto B's time -> "already booked", no change
 *  Failures             TC78 book · TC79 reschedule API error (simulated) + double-click Confirm: one request, booking
 *                       unchanged · TC80 declined card for the price difference: booking unchanged
 *
 * Bookings are kept afterwards unless TEETIME_CLEANUP=true.
 */

const NOT_AVAILABLE = "Not available within 4 hours of start";
const DECLINE_CARD = { card: "4000000000000002", exp: "1234", cvc: "123", zip: "12345" }; // Stripe test: generic decline

/** The booking is still where it was: same bay, time and players on the calendar (API + cells). */
async function expectUnchanged(app: BookingApp, b: CreatedBooking) {
  await app.open();
  await app.goToDate(b.date);
  await app.verifyBookingOnCalendar(b);
}

/** Leave reschedule mode with the booking's own "Cancel Reschedule" (X) button, if it is shown. */
async function leaveRescheduleMode(app: BookingApp, b: CreatedBooking) {
  const x = app.cell(b.bayId, b.startIdx).getByTitle("Cancel Reschedule");
  if (await x.isVisible()) await app.guidedClick(x);
  await expect(x).toBeHidden();
}

/** Click the first and last cell of a range (in reschedule mode, cells of other bookings can be picked too). */
async function pickRange(app: BookingApp, bayId: string, startIdx: number, endIdx: number) {
  await app.cell(bayId, startIdx).scrollIntoViewIfNeeded();
  await app.guidedClick(app.cell(bayId, startIdx), { position: { x: 12, y: 12 } });
  await app.guidedClick(app.cell(bayId, endIdx), { position: { x: 12, y: 12 } });
}

// ───────────────────────────── only once ─────────────────────────────

test.describe("Reschedule rules: only once @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let booking: CreatedBooking | undefined;
  let moved: CreatedBooking | undefined;

  test("TC62: book a slot (with the reschedule time free after it)", async ({}, testInfo) => {
    requireBookingCreation();
    booking = await bookFreeSlot(app, testInfo, { reuseOpenPage: true, alsoFree: rescheduleSlotsRange() });
    suite.track(booking);
    await app.viewMyBooking(booking, { highlight: false });
  });

  test("TC63: reschedule it -> calendar shows the new time", async ({}, testInfo) => {
    test.skip(!booking, "TC62 did not create a booking");
    await startReschedule(app, booking!);
    const next = await chooseNewTime(app, booking!, env.rescheduleStart, env.rescheduleEnd);
    await confirmChangeDetails(app, testInfo, "reschedule", next);
    moved = next;
    suite.track(moved);
    await app.viewMyBooking(moved); // back on /book-now: the booking at its new time
  });

  test("TC64: a rescheduled booking can't be rescheduled or shifted 15 min again", async () => {
    test.skip(!moved, "TC63 did not reschedule the booking");
    const menu = await app.openManageMenu(moved!);
    const reschedule = menu.getByRole("button", { name: /Reschedule/ }).filter({ hasText: NOT_AVAILABLE });
    await expect(reschedule, "Reschedule is disabled after one reschedule").toBeDisabled();
    await expect(menu.getByRole("button", { name: "15 min earlier", exact: true }), "15 min earlier disabled").toBeDisabled();
    await expect(menu.getByRole("button", { name: "15 min later", exact: true }), "15 min later disabled").toBeDisabled();
    await app.readPause();
    await app.page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });
});

// ───────────────────────────── leave without changing ─────────────────────────────

test.describe("Reschedule rules: leave without changing @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let booking: CreatedBooking | undefined;

  test("TC65: book a slot (with the reschedule time free after it)", async ({}, testInfo) => {
    requireBookingCreation();
    booking = await bookFreeSlot(app, testInfo, { reuseOpenPage: true, alsoFree: rescheduleSlotsRange() });
    suite.track(booking);
    await app.viewMyBooking(booking, { highlight: false });
  });

  test('TC66: "How to reschedule" -> Back returns to Manage your booking, no reschedule mode', async () => {
    test.skip(!booking, "TC65 did not create a booking");
    const b = booking!;
    await manageBooking(app, b, "reschedule");
    const rules = app.dialog("How to Reschedule");
    await expect(rules).toBeVisible();
    await app.guidedClick(rules.getByRole("button", { name: /Back|Close/ }).last(), { read: app.readMs });
    await expect(rules).toBeHidden();
    await expect(app.cell(b.bayId, b.startIdx).getByTitle("Cancel Reschedule"), "not in reschedule mode").toBeHidden();
    await app.page.keyboard.press("Escape"); // the Manage menu, if Back reopened it
    await expectUnchanged(app, b);
  });

  test("TC67: reschedule mode — other bays disabled, a shorter time refused, Cancel Reschedule (X) leaves it", async () => {
    test.skip(!booking, "TC65 did not create a booking");
    const b = booking!;
    await startReschedule(app, b);

    // Same bay only: the other bays' cells are disabled
    const bays = await app.baysForRange(b.startIdx, b.endIdx);
    const other = bays.find((x) => x.bayId !== b.bayId);
    if (other) {
      await expect(app.cell(other.bayId, b.startIdx), `${other.bayName} is disabled while rescheduling`).toHaveClass(/cursor-not-allowed/);
      await expect(app.cell(other.bayId, b.startIdx)).toHaveClass(/bg-gray-100/);
    }

    // A new time shorter than the booking is refused (30 min instead of the booking's length)
    const next = atTime(b, env.rescheduleStart, env.rescheduleEnd);
    await pickRange(app, b.bayId, next.startIdx, next.startIdx + 1);
    await app.guidedClick(app.page.getByRole("button", { name: "Reschedule", exact: true }), { read: app.readMs });
    await expect(toast(app.page, /must be at least/i), "shorter new time refused").toBeVisible();
    await expect(app.dialog("Reschedule Booking"), "no confirmation for a refused time").toBeHidden();

    // The booking's X leaves reschedule mode without changes
    await leaveRescheduleMode(app, b);
    await expectUnchanged(app, b);
  });

  test("TC68: Current/New confirmation -> Cancel: booking unchanged", async () => {
    test.skip(!booking, "TC65 did not create a booking");
    const b = booking!;
    await startReschedule(app, b);
    const next = atTime(b, env.rescheduleStart, env.rescheduleEnd);
    await app.selectSlots(b.bayId, next.startIdx, next.endIdx);
    await app.guidedClick(app.page.getByRole("button", { name: "Reschedule", exact: true }), { read: app.readMs });
    const confirm = await rescheduleConfirmation(app);
    await app.guidedClick(confirm.getByRole("button", { name: "Cancel", exact: true }), { read: app.readMs });
    await expect(confirm).toBeHidden();
    await leaveRescheduleMode(app, b);
    await expectUnchanged(app, b);
  });

  test('TC69: "Reschedule details" closed without confirming: booking unchanged', async () => {
    test.skip(!booking, "TC65 did not create a booking");
    const b = booking!;
    await startReschedule(app, b);
    await chooseNewTime(app, b, env.rescheduleStart, env.rescheduleEnd);
    const details = app.dialog("Reschedule details");
    await expect(details).toBeVisible({ timeout: 30_000 });
    await app.readPause();
    await app.page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await leaveRescheduleMode(app, b);
    await expectUnchanged(app, b);
  });

  test("TC70: Update Group Size offers exactly the bay's maximum (\"Up to N players\")", async () => {
    test.skip(!booking, "TC65 did not create a booking");
    const b = booking!;
    await manageBooking(app, b, "group size");
    const picker = app.dialog("Choose Number of Persons");
    await expect(picker).toBeVisible();
    const text = (await picker.innerText()).match(/Up to\s+(\d+)\s+players/i);
    expect(text, '"Up to N players allowed per bay" shown').toBeTruthy();
    const max = Number(text![1]);
    for (let n = 1; n <= max; n++) await expect(picker.getByRole("button", { name: String(n), exact: true })).toBeVisible();
    await expect(picker.getByRole("button", { name: String(max + 1), exact: true }), `no size above ${max}`).toHaveCount(0);
    await app.readPause();
    await app.page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    await expectUnchanged(app, b);
  });
});

// ───────────────────────────── another date ─────────────────────────────

test.describe("Reschedule rules: to another date @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let booking: CreatedBooking | undefined;

  test("TC71: book a slot", async ({}, testInfo) => {
    requireBookingCreation();
    booking = await bookFreeSlot(app, testInfo, { reuseOpenPage: true });
    suite.track(booking);
    await app.viewMyBooking(booking, { highlight: false });
  });

  test("TC72: reschedule to the next day (same bay) -> calendar shows the new date and time", async ({}, testInfo) => {
    test.skip(!booking, "TC71 did not create a booking");
    const b = booking!;
    await startReschedule(app, b);
    const nextDay = addDays(b.date, 1);
    await orBlocked(testInfo, () => app.goToDate(nextDay)); // stops (skips) if the account may not book that far ahead

    // First free time of the same length in the same bay on the next day
    const length = b.endIdx - b.startIdx;
    let start = -1;
    for (let s = 0; s + length <= 95; s++) {
      if ((await app.baysForRange(s, s + length)).find((x) => x.bayId === b.bayId)?.free) {
        start = s;
        break;
      }
    }
    if (start < 0) {
      testInfo.annotations.push({ type: "blocked", description: `${b.bayName} has no free ${length + 1} × 15 min on ${isoDate(nextDay)}` });
      test.skip(true, `${b.bayName} has no free time of the same length on ${isoDate(nextDay)}`);
    }
    const next: CreatedBooking = {
      ...atTime(b, fromMinutes(start * 15), fromMinutes((start + length + 1) * 15)),
      date: nextDay,
    };
    await app.selectSlots(b.bayId, next.startIdx, next.endIdx);
    await app.guidedClick(app.page.getByRole("button", { name: "Reschedule", exact: true }), { read: app.readMs });
    const confirm = await rescheduleConfirmation(app);
    await app.guidedClick(confirm.getByRole("button", { name: "Confirm Changes" }), { read: app.readMs });
    await expect(confirm).toBeHidden();
    await confirmChangeDetails(app, testInfo, "reschedule", next);
    suite.track(next);
    await app.viewMyBooking(next); // back on /book-now: the booking on the new date
  });
});

// ───────────────────────────── within 4 hours ─────────────────────────────

test.describe("Reschedule rules: within 4 hours of the start @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let booking: CreatedBooking | undefined;

  test("TC73: book today, starting within the next 4 hours", async ({}, testInfo) => {
    requireBookingCreation();
    // Start 30 min to 3 h 45 min from now, today only (skipped when no such time is free)
    booking = await bookFreeSlot(app, testInfo, { reuseOpenPage: true, tryNextDays: 0, todayWindow: { min: 30, max: 225 } });
    suite.track(booking);
    await app.viewMyBooking(booking, { highlight: false });
  });

  test('TC74: Reschedule disabled ("Not available within 4 hours of start"); the 15-min shifts still offered', async () => {
    test.skip(!booking, "TC73 did not create a booking");
    const menu = await app.openManageMenu(booking!);
    await expect(menu.getByRole("button", { name: /Reschedule/ }).filter({ hasText: NOT_AVAILABLE }), "Reschedule disabled").toBeDisabled();
    await expect(menu.getByRole("button", { name: "15 min earlier", exact: true }), "15 min earlier offered").toBeEnabled();
    await expect(menu.getByRole("button", { name: "15 min later", exact: true }), "15 min later offered").toBeEnabled();
    await app.readPause();
    await app.page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });
});

// ───────────────────────────── conflicts ─────────────────────────────

test.describe("Reschedule rules: conflicts with another booking @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let first: CreatedBooking | undefined;
  let second: CreatedBooking | undefined;

  test("TC75: book A, then B right after it in the same bay", async ({}, testInfo) => {
    requireBookingCreation();
    const length = env.bookingMinutes / 15;
    first = await bookFreeSlot(app, testInfo, { reuseOpenPage: true, alsoFree: slotsAfterRequested(length) });
    suite.track(first);
    await app.viewMyBooking(first, { highlight: false });

    // B: the same length, starting where A ends
    const b = atTime(first, first.endTime, fromMinutes((first.endIdx + 1 + length) * 15));
    await app.selectSlots(b.bayId, b.startIdx, b.endIdx);
    const modal = await fillBookingModal(app, testInfo, b);
    const bookingId = await app.confirmBooking(modal, { read: Math.min(1500, app.readMs) });
    second = { ...b, bookingId, groupSize: 1 };
    testInfo.annotations.push({ type: "second-booking", description: `${bookingId} ${b.startTime}–${b.endTime}` });
    await app.viewMyBooking(second, { highlight: false });
  });

  test('TC76: "15 min later" on A while B starts right after it -> "already booked", nothing changes', async () => {
    test.skip(!first || !second, "TC75 did not create both bookings");
    const menu = await app.openManageMenu(first!);
    await app.guidedClick(menu.getByRole("button", { name: "15 min later", exact: true }), { read: app.readMs });
    // The app may ask to confirm first; the conflict is reported either way
    const confirm = app.dialog("Reschedule Booking");
    if (await confirm.isVisible().catch(() => false)) {
      await app.guidedClick(confirm.getByRole("button", { name: "Confirm Changes" }), { read: app.readMs });
    }
    await expect(toast(app.page, /already booked/i), "conflict reported").toBeVisible();
    await expectUnchanged(app, first!);
    await app.verifyBookingOnCalendar(second!);
  });

  test("TC77: reschedule A onto B's time -> \"already booked\", nothing changes", async () => {
    test.skip(!first || !second, "TC75 did not create both bookings");
    await startReschedule(app, first!);
    await pickRange(app, first!.bayId, second!.startIdx, second!.endIdx);
    await app.guidedClick(app.page.getByRole("button", { name: "Reschedule", exact: true }), { read: app.readMs });
    await expect(toast(app.page, /already booked/i), "conflict reported").toBeVisible();
    await expect(app.dialog("Reschedule Booking"), "no confirmation for a taken time").toBeHidden();
    await leaveRescheduleMode(app, first!);
    await expectUnchanged(app, first!);
    await app.verifyBookingOnCalendar(second!);
  });
});

// ───────────────────────────── failures ─────────────────────────────

test.describe("Reschedule rules: failures @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let booking: CreatedBooking | undefined;

  test("TC78: book a slot (with the reschedule time free after it)", async ({}, testInfo) => {
    requireBookingCreation();
    booking = await bookFreeSlot(app, testInfo, { reuseOpenPage: true, alsoFree: rescheduleSlotsRange() });
    suite.track(booking);
    await app.viewMyBooking(booking, { highlight: false });
  });

  test("TC79: reschedule API error (simulated) + double-click Confirm -> one request, error shown, booking unchanged", async ({}, testInfo) => {
    test.skip(!booking, "TC78 did not create a booking");
    const b = booking!;
    await startReschedule(app, b);
    await chooseNewTime(app, b, env.rescheduleStart, env.rescheduleEnd);
    const details = app.dialog("Reschedule details");
    await expect(details).toBeVisible({ timeout: 30_000 });
    await app.scrollThrough(details);
    if ((await app.amountToPay(details)) > 0) await orBlocked(testInfo, () => app.preparePayment(details));
    await app.acceptWaiver(details);

    // The API answers 500 after a short delay; nothing reaches the backend
    let requests = 0;
    await app.page.route(`${env.apiURL}/**/booking/reschedule/${b.bookingId}*`, async (route) => {
      requests++;
      await new Promise((r) => setTimeout(r, 1000));
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ success: false, message: "E2E: reschedule failed" }) });
    });
    const confirm = details.getByRole("button", { name: /^Confirm/ });
    await confirm.scrollIntoViewIfNeeded();
    await confirm.dblclick();
    await app.page.waitForTimeout(3000);
    await app.page.unrouteAll({ behavior: "ignoreErrors" });

    expect(requests, "a double-click sends one reschedule request").toBe(1);
    await expect(app.page, "not sent to the success screen").not.toHaveURL(/\/book-slot\/success/);
    // The app's reschedule hook logs the error but has no toast: report it without stopping the test
    await expect.soft(toast(app.page, /failed|went wrong|error/i), "the user sees an error message").toBeVisible({ timeout: 5000 });
    await app.page.keyboard.press("Escape");
    await leaveRescheduleMode(app, b);
    await expectUnchanged(app, b);
  });

  test("TC80: declined card for the price difference -> error, booking unchanged", async ({}, testInfo) => {
    test.skip(!booking, "TC78 did not create a booking");
    const b = booking!;
    await startReschedule(app, b);
    await chooseNewTime(app, b, env.rescheduleStart, env.rescheduleEnd); // longer than the booking, so it costs more
    const details = app.dialog("Reschedule details");
    await expect(details).toBeVisible({ timeout: 30_000 });
    await app.scrollThrough(details);
    const toPay = await app.amountToPay(details);
    testInfo.annotations.push({ type: "you-pay", description: `$${toPay.toFixed(2)}` });
    if (toPay <= 0) {
      await app.page.keyboard.press("Escape");
      await leaveRescheduleMode(app, b);
      test.skip(true, 'Nothing to pay for the new time ("You pay" $0.00), so no card is charged');
    }
    await app.enterCard(details, DECLINE_CARD);
    await app.acceptWaiver(details);

    const responsePromise = app.page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().startsWith(env.apiURL) && r.url().includes(`/booking/reschedule/${b.bookingId}`),
      { timeout: 60_000 },
    );
    await app.guidedClick(details.getByRole("button", { name: /^Confirm/ }), { read: Math.min(1500, app.readMs) });
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    testInfo.annotations.push({ type: "reschedule-response", description: `HTTP ${response.status()} ${JSON.stringify(body).slice(0, 200)}` });
    expect(response.ok() && body?.success !== false, "the reschedule must fail for a declined card").toBe(false);
    await expect(app.page, "not sent to the success screen").not.toHaveURL(/\/book-slot\/success/);
    await expect.soft(toast(app.page, /declined|failed|error/i), "the user sees the payment error").toBeVisible({ timeout: 5000 });
    await app.page.keyboard.press("Escape");
    await leaveRescheduleMode(app, b);
    await expectUnchanged(app, b);
  });
});
