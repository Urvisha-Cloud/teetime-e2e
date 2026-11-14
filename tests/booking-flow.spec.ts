import type { TestInfo } from "@playwright/test";
import { BookingApp, type CreatedBooking } from "../support/booking-app";
import { env } from "../support/env";
import { fromMinutes, slotRange, toMinutes } from "../support/time";
import { expect, orBlocked, requireBookingCreation, selectRequestedSlot, test, testUser } from "./fixtures";

/**
 * Test cases 42–47 — the whole life of ONE booking, step by step, in one Chrome window:
 *
 *  TC42  login: no saved test user (or it was deleted) -> a new teetime-e2e-…@yopmail.com user signs up;
 *        saved user exists -> it logs in (email + test code). Then the booking calendar loads signed in.
 *  TC43  create: book TEETIME_SLOT_START–END (default 8–9 PM tomorrow, 1 player) -> Booking Confirmed -> calendar
 *  TC44  reschedule: ⋮ -> "Manage your booking" -> Reschedule -> Start rescheduling -> new time
 *        TEETIME_RESCHEDULE_START–END (default 9–11 PM, same bay) -> Confirm changes -> "Reschedule details"
 *        (group size unchanged) -> Booking Confirmed -> calendar
 *  TC45  update group size: ⋮ -> Update Group Size -> TEETIME_GROUP_SIZE_UPDATE (default 5) -> Add players
 *        -> "Reschedule details" -> Booking Confirmed -> calendar
 *  TC46  extend: ⋮ -> Extend Booking -> TEETIME_EXTEND_BY (default "+30 min") -> Continue -> "Extend details"
 *        -> Booking Confirmed with the new end time -> calendar
 *  TC47  cancel: ⋮ -> Cancel booking -> Confirm cancellation -> "Booking cancelled" -> calendar slots free again
 *
 * Each step needs the one before it; a failed step skips the rest. If the run stops before TC47, the booking is
 * cancelled afterwards (TEETIME_CLEANUP=true). The separate files (booking-reschedule / -extend / -cancel) test the
 * same screens on their own bookings.
 */
test.describe("Booking flow: login -> create -> reschedule -> group size -> extend -> cancel @creates-booking", () => {
  test.describe.configure({ mode: "serial" });

  let app: BookingApp;
  let loggedIn = false;
  let booking: CreatedBooking | undefined; // the booking as it is after the latest step
  let rescheduled = false;
  let resized = false;
  let extended = false;
  let cancelled = false;
  const GROUP_SIZE = 1;

  /** "+30 min" -> 30, "+1 hr" -> 60 (the quick picks in the "Extend booking" popup). */
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

  /** Booking's ⋮ (more) button on the calendar -> the "Manage your booking" modal. */
  async function openManageMenu(b: CreatedBooking) {
    const startCell = app.cell(b.bayId, b.startIdx);
    await startCell.scrollIntoViewIfNeeded();
    await startCell.getByRole("button").first().click();
    const menu = dialog("Manage your booking");
    await expect(menu).toBeVisible();
    return menu;
  }

  /**
   * "Reschedule details" / "Extend details" modal: group size (reschedule only), payment when "You pay" is above
   * $0.00, waiver -> Confirm -> PATCH <apiPath>/:id -> "Booking Confirmed" for `b`.
   */
  async function confirmDetails(
    title: "Reschedule details" | "Extend details",
    apiPath: string,
    b: CreatedBooking,
    testInfo: TestInfo,
    { pickGroupSize = false } = {},
  ) {
    const details = dialog(title);
    await expect(details).toBeVisible({ timeout: 30_000 });
    // Select the size only if it isn't already selected (clicking a selected size could unselect it)
    if (pickGroupSize) {
      const selected = /bg-green-600/.test((await app.groupSizeButton(details, b.groupSize).getAttribute("class")) ?? "");
      if (!selected) await app.selectGroupSize(details, b.groupSize);
    }
    if (title === "Reschedule details") await app.verifyGroupSize(details, b.groupSize);
    const toPay = await app.amountToPay(details);
    testInfo.annotations.push({ type: "you-pay", description: `${title}: $${toPay.toFixed(2)}` });
    if (toPay > 0) await orBlocked(testInfo, () => app.preparePayment(details));
    await app.acceptWaiver(details);

    const responsePromise = app.page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().startsWith(env.apiURL) && r.url().includes(`${apiPath}/${b.bookingId}`),
      { timeout: 60_000 },
    );
    await details.getByRole("button", { name: /^Confirm/ }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    testInfo.annotations.push({ type: `${apiPath}-response`, description: `HTTP ${response.status()} ${JSON.stringify(body).slice(0, 200)}` });
    expect(response.status(), `${apiPath} HTTP status (body: ${JSON.stringify(body).slice(0, 300)})`).toBeLessThan(400);

    await expect(app.page).toHaveURL(new RegExp(`/book-slot/success\\?bookingId=${b.bookingId}`), { timeout: 30_000 });
    await app.verifyCheckout(b); // "Booking Confirmed": time range and number of persons
    await app.page.waitForTimeout(env.showMs);
  }

  /** View My Booking -> calendar on the booking's date -> booking verified there, outlined in green for a moment. */
  async function showOnCalendar(b: CreatedBooking) {
    await app.page.getByRole("button", { name: "View My Booking" }).click();
    await app.waitForBookingUi();
    await app.goToDate(b.date);
    await app.verifyBookingOnCalendar(b); // bay, time and number of persons from the API + calendar cells
    await app.cell(b.bayId, b.startIdx).scrollIntoViewIfNeeded();
    for (let s = b.startIdx; s <= b.endIdx; s++) {
      await app.cell(b.bayId, s).evaluate((el) => {
        (el as HTMLElement).style.outline = "3px solid #16a34a";
        (el as HTMLElement).style.outlineOffset = "-3px";
      });
    }
    await app.page.waitForTimeout(env.showMs);
  }

  test("TC42: login — new user signs up, or the existing user logs in", async ({}, testInfo) => {
    // The sign-up / login itself runs once per run in fixtures.ts (one Chrome window for every step).
    if (testUser.result) {
      const what = testUser.result === "signup" ? "new user created (sign up)" : "existing user logged in";
      testInfo.annotations.push({ type: "login", description: `${what}: ${testUser.email}` });
      console.log(`[teetime-e2e] TC42: ${what}: ${testUser.email}`);
    }
    await app.open();
    await app.waitForBookingUi();
    await expect(app.page.locator("input#email"), "no login popup: the user is signed in").toBeHidden();
    // An authorised API call works with the saved token (it fails when the user is signed out).
    const ids = await app.myActiveBookingIds();
    testInfo.annotations.push({ type: "active-bookings", description: String(ids.length) });
    loggedIn = true;
  });

  test("TC43: create — book the slot -> Booking Confirmed -> calendar", async ({}, testInfo) => {
    test.skip(!loggedIn, "TC42 login failed");
    requireBookingCreation();
    const sel = await selectRequestedSlot(app, testInfo);
    // Later steps need the same bay free for the new time AND the extension after it (default 9:00–11:30 PM).
    const r = slotRange(env.rescheduleStart, env.rescheduleEnd);
    const bays = await app.baysForRange(r.startIdx, r.endIdx + extraSlots);
    if (!bays.find((b) => b.bayId === sel.bayId)?.free) {
      const why = `${sel.bayName} is not free ${env.rescheduleStart}–${fromMinutes(toMinutes(env.rescheduleEnd) + extendMinutes)}`;
      testInfo.annotations.push({ type: "blocked", description: why });
      test.skip(true, why);
    }

    const modal = await app.openBookingModal(sel);
    await app.selectGroupSize(modal, GROUP_SIZE);
    await app.acceptWaiver(modal);
    await orBlocked(testInfo, () => app.preparePayment(modal));
    const bookingId = await app.confirmBooking(modal);
    booking = { ...sel, bookingId, groupSize: GROUP_SIZE };
    testInfo.annotations.push({ type: "bookingId", description: bookingId });

    await expect(app.page).toHaveURL(new RegExp(`/book-slot/success\\?bookingId=${bookingId}`), { timeout: 30_000 });
    await app.verifyCheckout(booking);
    await app.page.waitForTimeout(env.showMs);
    await showOnCalendar(booking);
  });

  test(`TC44: reschedule — new time ${env.rescheduleStart}–${env.rescheduleEnd}, same group size -> Booking Confirmed -> calendar`, async ({}, testInfo) => {
    test.skip(!booking, "TC43 did not create a booking");
    const before = booking!;
    const menu = await openManageMenu(before);
    await menu.getByRole("button", { name: /Reschedule/ }).filter({ hasText: "Choose a new time" }).click();

    const rules = dialog("How to Reschedule");
    await expect(rules).toBeVisible();
    await rules.getByRole("button", { name: /Start rescheduling/i }).click();
    await expect(rules).toBeHidden();
    await expect(app.cell(before.bayId, before.startIdx).getByTitle("Cancel Reschedule")).toBeVisible();

    const { startIdx, endIdx } = slotRange(env.rescheduleStart, env.rescheduleEnd);
    await app.cell(before.bayId, startIdx).scrollIntoViewIfNeeded();
    await app.cell(before.bayId, startIdx).click({ position: { x: 12, y: 12 } });
    await app.cell(before.bayId, endIdx).click({ position: { x: 12, y: 12 } });
    await app.page.getByRole("button", { name: "Reschedule", exact: true }).click();
    const confirm = dialog("Reschedule Booking");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Confirm Changes" }).click();
    await expect(confirm).toBeHidden();

    const after: CreatedBooking = {
      ...before,
      startIdx,
      endIdx,
      startTime: env.rescheduleStart,
      endTime: env.rescheduleEnd,
      // group size is not changed here; TC45 changes it
    };
    await confirmDetails("Reschedule details", "/booking/reschedule", after, testInfo, { pickGroupSize: true });
    booking = after;
    rescheduled = true;
    await showOnCalendar(booking);
  });

  test(`TC45: update group size — ${env.groupSizeUpdate} players -> Booking Confirmed -> calendar`, async ({}, testInfo) => {
    test.skip(!rescheduled, "TC44 did not reschedule the booking");
    const before = booking!;
    expect(env.groupSizeUpdate, "TEETIME_GROUP_SIZE_UPDATE must be larger than the current group size").toBeGreaterThan(before.groupSize);
    const menu = await openManageMenu(before);
    await menu.getByRole("button", { name: /Update Group Size/ }).click();

    const picker = dialog("Choose Number of Persons");
    await expect(picker).toBeVisible();
    const addPlayers = picker.getByRole("button", { name: /^Add players/ });
    await expect(addPlayers, "disabled until a larger group size is picked").toBeDisabled();
    await picker.getByRole("button", { name: String(env.groupSizeUpdate), exact: true }).click();
    await addPlayers.click();
    await expect(picker).toBeHidden();

    const after: CreatedBooking = { ...before, groupSize: env.groupSizeUpdate };
    await confirmDetails("Reschedule details", "/booking/reschedule", after, testInfo);
    booking = after;
    resized = true;
    await showOnCalendar(booking);
  });

  test(`TC46: extend — ${env.extendBy} -> Booking Confirmed with the new end time -> calendar`, async ({}, testInfo) => {
    test.skip(!resized, "TC45 did not update the group size");
    const before = booking!;
    const menu = await openManageMenu(before);
    await menu.getByRole("button", { name: /Extend Booking/ }).click();

    const extend = dialog("additional time");
    await expect(extend).toBeVisible();
    await extend.getByRole("button", { name: env.extendBy, exact: true }).click();
    const newEnd = fromMinutes(toMinutes(before.endTime) + extendMinutes);
    await expect(extend, `"Ends ${newEnd}" after picking ${env.extendBy}`).toContainText(`Ends ${newEnd}`);
    await extend.getByRole("button", { name: /Continue/ }).click();
    await expect(extend).toBeHidden();

    const after: CreatedBooking = { ...before, endIdx: before.endIdx + extraSlots, endTime: newEnd };
    await confirmDetails("Extend details", "/booking/extend", after, testInfo);
    booking = after;
    extended = true;
    await showOnCalendar(booking);
  });

  test("TC47: cancel — Cancel booking -> Confirm cancellation -> calendar slots free again", async ({}, testInfo) => {
    test.skip(!extended, "TC46 did not extend the booking");
    const b = booking!;
    const menu = await openManageMenu(b);
    await menu.getByRole("button", { name: "Cancel booking", exact: true }).click();

    const cancel = dialog("Confirm Cancellation");
    await expect(cancel).toBeVisible();
    const responsePromise = app.page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().startsWith(env.apiURL) && r.url().includes(`/booking/cancel/${b.bookingId}`),
      { timeout: 60_000 },
    );
    await cancel.getByRole("button", { name: "Confirm Cancellation" }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    testInfo.annotations.push({ type: "cancel-response", description: `HTTP ${response.status()} ${JSON.stringify(body).slice(0, 200)}` });
    expect(response.status(), `cancel HTTP status (body: ${JSON.stringify(body).slice(0, 300)})`).toBeLessThan(400);
    await expect(app.page.getByText("Booking cancelled")).toBeVisible();
    cancelled = true;

    await app.goToDate(b.date);
    await expect
      .poll(async () => (await app.myActiveBookingIds()).includes(b.bookingId), { message: "cancelled booking still listed as active", timeout: 20_000 })
      .toBe(false);
    await app.cell(b.bayId, b.startIdx).scrollIntoViewIfNeeded();
    for (let s = b.startIdx; s <= b.endIdx; s++) {
      await expect(app.cell(b.bayId, s)).not.toHaveClass(/before:border-green-600/);
    }
    const bays = await app.baysForRange(b.startIdx, b.endIdx);
    expect(bays.find((x) => x.bayId === b.bayId)?.free, `${b.bayName} is free again`).toBe(true);
    await app.page.waitForTimeout(env.showMs);
  });
});
