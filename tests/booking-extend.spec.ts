import type { BookingApp, CreatedBooking, SelectedBooking } from "../support/booking-app";
import { env } from "../support/env";
import { toast } from "../support/guards";
import { fromMinutes, toMinutes } from "../support/time";
import {
  bookFreeSlot,
  bookingSuite,
  bookSlot,
  confirmChangeDetails,
  continueExtend,
  extendedBy,
  exerciseExtendControls,
  expectConfirmed,
  formatMinutes,
  manageBooking,
  openExtendPopup,
  orBlocked,
  presetSlots,
  requireBookingCreation,
  selectRequestedSlot,
  slotsAfterRequested,
  stepExtendTo,
} from "./helper";
import { expect, test } from "./fixtures";

/**
 * Every extend-booking case, one booking per describe (cancelled afterwards when TEETIME_CLEANUP=true):
 *  TC38–41  quick pick TEETIME_EXTEND_BY (default "+30 min") -> Extend details -> Booking Confirmed -> calendar
 *  TC54–57  every popup control (+ / −, presets, maximum past midnight, slider) -> +45 min -> Extend details
 *           -> Booking Confirmed -> calendar
 *  TC58–61  the time right after the booking is taken -> the popup offers "Book a new session instead" ->
 *           "Same bay, later" -> 1 hr -> Continue -> Book Now -> the new session is booked; the first one is unchanged
 *  TC93     same popup: "Switch bay, keep playing" when another bay is free (used, not booked); Trackman if offered
 *  TC90–92  only 30 min free after the booking (another booking starts then) -> the popup stops at 30 min ->
 *           extend to that limit -> Booking Confirmed -> calendar
 *  TC94–95  the extra time is taken while extending (the API's "already booked" answer, simulated) -> booking unchanged
 *  TC96–97  the latest booking of the day extended past midnight -> Booking Confirmed with the next-day end time
 *  TC98–99  a session in progress -> the floating "Extend session" button -> +15 min -> Booking Confirmed
 *  TC100–102 (extend to another bay) are in switch-bay-extend.spec.ts, the last part of npm test
 */

test.describe("Extend a booking @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a));
  let original: CreatedBooking | undefined;
  let extended: CreatedBooking | undefined;
  const extraSlots = presetSlots(env.extendBy);

  test("TC38: book the slot to extend", async ({}, testInfo) => {
    requireBookingCreation();
    // The extra time right after the booking must be free in the same bay, or "Extend Booking" is not offered.
    original = await bookFreeSlot(app, testInfo, { alsoFree: slotsAfterRequested(extraSlots) });
    suite.track(original);
    await app.viewMyBooking(original, { highlight: false });
  });

  test(`TC39: ⋮ menu -> Manage your booking -> Extend Booking -> ${env.extendBy} -> Continue`, async () => {
    test.skip(!original, "TC38 did not create a booking");
    const popup = await openExtendPopup(app, original!);
    await app.guidedClick(popup.getByRole("button", { name: env.extendBy, exact: true }));
    extended = await continueExtend(app, popup, original!, extraSlots);
  });

  test("TC40: Extend details -> waiver -> Confirm -> Booking Confirmed with the new end time", async ({}, testInfo) => {
    test.skip(!extended, "TC39 did not start the extension");
    // Pays for the extra time only when "You pay" is above $0.00 (wallet / gift credit could cover it)
    await confirmChangeDetails(app, testInfo, "extend", extended!);
  });

  test("TC41: View My Booking -> calendar shows the booking up to the new end time", async () => {
    test.skip(!extended, "TC39 did not start the extension");
    await app.viewMyBooking(extended!); // every slot from the start to the new end belongs to the booking
  });
});

test.describe("Extend booking: slider, + / − and presets @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let original: CreatedBooking | undefined;
  let extended: CreatedBooking | undefined;
  const MAX_SLOTS = 12; // the popup offers up to 3 hours (12 × 15 min) when that time is free
  const PICK_SLOTS = 3; // final choice: +45 min (as in the screenshots)

  test("TC54: book the slot to extend (3 hours after it free)", async ({}, testInfo) => {
    requireBookingCreation();
    // The popup's maximum (3 hr) is only offered when that time after the booking is free in the same bay
    original = await bookFreeSlot(app, testInfo, { reuseOpenPage: true, alsoFree: slotsAfterRequested(MAX_SLOTS) });
    suite.track(original);
    await app.viewMyBooking(original, { highlight: false });
  });

  test("TC55: slider, + / − and presets all drive one value; limits and end time (incl. past midnight)", async ({}, testInfo) => {
    test.skip(!original, "TC54 did not create a booking");
    const popup = await openExtendPopup(app, original!);
    const max = await exerciseExtendControls(app, popup, original!, PICK_SLOTS);
    testInfo.annotations.push({ type: "max", description: `${max} slots (${formatMinutes(max * 15)})` });
    expect(max, "3 hours were checked free, so the popup offers up to 3 hr").toBe(MAX_SLOTS);
    extended = await continueExtend(app, popup, original!, PICK_SLOTS);
  });

  test("TC56: Extend details -> waiver -> Confirm -> Booking Confirmed with the new end time", async ({}, testInfo) => {
    test.skip(!extended, "TC55 did not pick the extra time");
    await confirmChangeDetails(app, testInfo, "extend", extended!); // same start, NEW end time, same group size
  });

  test("TC57: View My Booking -> calendar shows the booking up to the new end time", async () => {
    test.skip(!extended, "TC55 did not pick the extra time");
    await app.viewMyBooking(extended!); // every slot from the start to the new end belongs to the booking
  });
});

test.describe("Extend booking: time after is taken -> book a new session instead @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let first: CreatedBooking | undefined; // the booking we try to extend
  let blocker: CreatedBooking | undefined; // the hour right after it, same bay (makes "extend" impossible)
  let next: SelectedBooking | undefined; // the new session picked in the popup ("Same bay, later")
  let booked: CreatedBooking | undefined;
  const HOUR = 4; // 1 hr in 15-min slots

  /** The hour right after `b` in the same bay. */
  const hourAfter = (b: SelectedBooking): SelectedBooking => ({
    ...b,
    startIdx: b.endIdx + 1,
    endIdx: b.endIdx + HOUR,
    startTime: b.endTime,
    endTime: fromMinutes(toMinutes(b.endTime) + HOUR * 15),
  });

  test("TC58: book a slot, then the hour right after it in the same bay (so there is no time to extend into)", async ({}, testInfo) => {
    requireBookingCreation();
    // One bay free for: the booking, the blocking hour after it, and the hour after that (the "Same bay, later" session)
    first = await bookFreeSlot(app, testInfo, { reuseOpenPage: true, alsoFree: slotsAfterRequested(2 * HOUR) });
    suite.track(first);
    await app.viewMyBooking(first, { highlight: false });

    // The blocker: select the next hour in the same bay on the calendar and book it
    const sel = hourAfter(first);
    await app.guidedClick(app.cell(sel.bayId, sel.startIdx), { position: { x: 12, y: 12 } });
    await app.guidedClick(app.cell(sel.bayId, sel.endIdx), { position: { x: 12, y: 12 } });
    await app.verifySelectionHeader(sel);
    blocker = await bookSlot(app, testInfo, sel);
    await expectConfirmed(app, blocker);
    await app.viewMyBooking(first, { highlight: false });
    await app.verifyBookingOnCalendar(blocker);
  });

  test("TC59: ⋮ -> Extend Booking -> 'already booked' -> Same bay, later -> 1 hr -> Continue selects the new session", async () => {
    test.skip(!first || !blocker, "TC58 did not create both bookings");
    await manageBooking(app, first!, "extend");

    // No time to extend into: the popup offers other sessions instead of the extend controls
    const popup = app.dialog("already booked");
    await expect(popup).toBeVisible();
    await expect(popup.getByRole("heading", { name: "Extend Booking" })).toBeVisible();
    await expect(popup).toContainText("The time right after your session is already booked");
    await expect(popup).toContainText("Book a new session instead");
    await expect(popup.getByRole("slider", { name: "Additional time" }), "no extend slider when nothing is free").toHaveCount(0);

    // "Same bay, later": the first free time after the blocking booking, in the same bay
    next = hourAfter(blocker!);
    const sameBay = popup.getByRole("button").filter({ hasText: "Same bay, later" });
    await expect(sameBay).toBeVisible();
    await expect(sameBay).toContainText(`from ${next.startTime}`);
    await app.guidedClick(sameBay, { read: app.readMs });

    // Size the new session: starts at 1 hr; the preview shows the bay and the time range.
    // The popup's subtitle changes to "Same bay, later · <bay>", so find it by its new text.
    const picked = app.dialog("How long do you want to play?");
    await expect(picked).toBeVisible();
    await expect(picked.getByRole("slider", { name: "Session length" })).toBeVisible();
    await expect(picked.locator("div.text-2xl"), "session length").toHaveText(formatMinutes(HOUR * 15));
    await expect(picked).toContainText(`${next.bayName} · ${next.startTime} – ${next.endTime}`);
    await app.guidedClick(picked.getByRole("button", { name: /Continue/ }), { read: app.readMs });
    await expect(picked).toBeHidden();

    // Continue puts the new session on the calendar as the selection (header shows it, Book Now appears)
    for (let s = next.startIdx; s <= next.endIdx; s++) await expect(app.cell(next.bayId, s)).toHaveClass(/bg-green-400\/50/);
    await app.verifySelectionHeader(next);
  });

  test("TC60: Book Now -> Booking Details -> waiver -> Confirm -> Booking Confirmed for the new session", async ({}, testInfo) => {
    test.skip(!next, "TC59 did not select the new session");
    booked = await bookSlot(app, testInfo, next!);
    await expectConfirmed(app, booked);
  });

  test("TC61: View My Booking -> calendar shows the new session; the first booking and the blocker are unchanged", async () => {
    test.skip(!booked, "TC60 did not book the new session");
    await app.viewMyBooking(booked!);
    await app.verifyBookingOnCalendar(first!); // still its own original time, not extended
    await app.verifyBookingOnCalendar(blocker!);
  });

  test("TC93: the 'already booked' popup also offers another bay ('Switch bay, keep playing') and Trackman when free", async ({}, testInfo) => {
    test.skip(!first || !blocker, "TC58 did not create both bookings");
    await app.open();
    await app.goToDate(first!.date);
    // Which other bays are free for the hour right after the first booking (what "Switch bay" can offer)
    const hour = hourAfter(first!);
    const otherFree = (await app.baysForRange(hour.startIdx, hour.endIdx)).filter((x) => x.bayId !== first!.bayId && x.free);
    await manageBooking(app, first!, "extend");
    const popup = app.dialog("already booked");
    await expect(popup).toBeVisible();
    const switchBay = popup.getByRole("button").filter({ hasText: "Switch bay, keep playing" });
    const trackman = popup.getByRole("button").filter({ hasText: "Switch to Trackman" });
    testInfo.annotations.push({
      type: "alternatives",
      description: `other bays free from ${hour.startTime}: ${otherFree.map((b) => b.bayName).join(", ") || "none"}; Trackman offered: ${await trackman.isVisible()}`,
    });
    if (otherFree.length === 0) {
      await expect(switchBay, "no other bay is free, so no Switch bay").toHaveCount(0);
      await app.page.keyboard.press("Escape");
      return;
    }
    await expect.soft(switchBay, "another bay is free, so Switch bay is offered").toBeVisible();
    if (!(await switchBay.isVisible())) return;
    await app.guidedClick(switchBay, { read: app.readMs });

    // A new session on another bay, starting where the first booking ends; Continue selects it on the calendar.
    // The subtitle changes to "Switch bay, keep playing · <bay>", so find the popup by its new text.
    const picked = app.dialog("How long do you want to play?");
    await expect(picked).toBeVisible();
    await expect(picked).toContainText(hour.startTime);
    await app.guidedClick(picked.getByRole("button", { name: /Continue/ }), { read: app.readMs });
    await expect(picked).toBeHidden();
    const selectedElsewhere = await app.page.evaluate(
      ({ bay, slot }) =>
        Array.from(document.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)).some(
          (c) => c.getAttribute("data-screen") !== bay && c.className.includes("bg-green-400/50"),
        ),
      { bay: first!.bayId, slot: hour.startIdx },
    );
    expect(selectedElsewhere, "the new session is selected on another bay").toBe(true);
    await expect(app.bookNowButton()).toBeVisible();
    await app.open(); // not booked: reload clears the selection
  });
});

// ───────────────────────────── only part of the time after is free ─────────────────────────────

test.describe("Extend booking: only 30 min free after the booking @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let first: CreatedBooking | undefined;
  let blocker: CreatedBooking | undefined;
  let extended: CreatedBooking | undefined;
  const GAP = 2; // 30 min free after the booking
  const HOUR = 4;

  test("TC90: book a slot, then another booking starting 30 min after it (same bay)", async ({}, testInfo) => {
    requireBookingCreation();
    first = await bookFreeSlot(app, testInfo, { reuseOpenPage: true, rescheduleRoom: false, alsoFree: slotsAfterRequested(GAP + HOUR) });
    suite.track(first);
    await app.viewMyBooking(first, { highlight: false });

    const start = first.endIdx + 1 + GAP;
    const sel: SelectedBooking = {
      ...first,
      startIdx: start,
      endIdx: start + HOUR - 1,
      startTime: fromMinutes(start * 15),
      endTime: fromMinutes((start + HOUR) * 15),
    };
    await app.selectSlots(sel.bayId, sel.startIdx, sel.endIdx);
    await app.verifySelectionHeader(sel);
    blocker = await bookSlot(app, testInfo, sel);
    await expectConfirmed(app, blocker);
    await app.viewMyBooking(first, { highlight: false });
    await app.verifyBookingOnCalendar(blocker);
  });

  test("TC91: Extend Booking offers only the free 30 min (slider max, + disabled, no longer presets, 'Need more than 30 min?')", async () => {
    test.skip(!first || !blocker, "TC90 did not create both bookings");
    const popup = await openExtendPopup(app, first!);
    await expect(popup, "limit in the subtitle").toContainText(`Up to ${formatMinutes(GAP * 15)} available after your session`);
    const slider = popup.getByRole("slider", { name: "Additional time" });
    expect(Number(await slider.getAttribute("max")), "slider maximum = the free time").toBe(GAP);
    await expect(popup.getByRole("button", { name: "+1 hr", exact: true }), "presets longer than the free time are hidden").toHaveCount(0);
    await app.guidedClick(popup.getByRole("button", { name: "+30 min", exact: true }));
    await expect(popup.getByRole("button", { name: "Add 15 minutes" }), "+ disabled at the limit").toBeDisabled();
    await expect(popup, "other sessions offered at the limit").toContainText(`Need more than ${formatMinutes(GAP * 15)}?`);
    await app.readPause();
    extended = await continueExtend(app, popup, first!, GAP);
  });

  test("TC92: extend up to the limit -> Booking Confirmed -> calendar: the booking ends where the next one starts", async ({}, testInfo) => {
    test.skip(!extended, "TC91 did not pick the extra time");
    await confirmChangeDetails(app, testInfo, "extend", extended!);
    suite.track(extended!);
    await app.viewMyBooking(extended!);
    await app.verifyBookingOnCalendar(blocker!);
  });
});

// ───────────────────────────── the extra time gets taken meanwhile ─────────────────────────────

test.describe("Extend booking: the extra time is taken while extending (simulated) @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let original: CreatedBooking | undefined;
  const extraSlots = presetSlots(env.extendBy);

  test("TC94: book a slot to extend", async ({}, testInfo) => {
    requireBookingCreation();
    original = await bookFreeSlot(app, testInfo, { reuseOpenPage: true, rescheduleRoom: false, alsoFree: slotsAfterRequested(extraSlots) });
    suite.track(original);
    await app.viewMyBooking(original, { highlight: false });
  });

  test("TC95: Confirm while the API answers 'Bay already booked' -> no success screen, booking keeps its old end time", async ({}, testInfo) => {
    test.skip(!original, "TC94 did not create a booking");
    const b = original!;
    const popup = await openExtendPopup(app, b);
    await app.guidedClick(popup.getByRole("button", { name: env.extendBy, exact: true }));
    await continueExtend(app, popup, b, extraSlots);
    const details = app.dialog("Extend details");
    await expect(details).toBeVisible({ timeout: 30_000 });
    await app.scrollThrough(details);
    if ((await app.amountToPay(details)) > 0) await orBlocked(testInfo, () => app.preparePayment(details));
    await app.acceptWaiver(details);

    // Someone else took the time in the meantime: the backend's answer for that case, simulated (nothing is charged)
    let requests = 0;
    await app.page.route(`${env.apiURL}/**/booking/extend/${b.bookingId}*`, async (route) => {
      requests++;
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ success: false, message: "Bay already booked for this time" }) });
    });
    await app.guidedClick(details.getByRole("button", { name: /^Confirm/ }), { read: Math.min(1500, app.readMs) });
    await expect.poll(() => requests, { message: "extend request sent" }).toBeGreaterThan(0);
    await app.page.waitForTimeout(1500);
    await app.page.unrouteAll({ behavior: "ignoreErrors" });
    expect(requests, "one extend request").toBe(1);
    await expect(app.page, "not sent to the success screen").not.toHaveURL(/\/book-slot\/success/);
    await expect.soft(toast(app.page, /already booked|failed|error/i), "the user sees why it failed").toBeVisible({ timeout: 5000 });

    // Unchanged: same end time, the extra time is not the booking's
    await app.page.keyboard.press("Escape");
    await app.open();
    await app.goToDate(b.date);
    await app.verifyBookingOnCalendar(b);
    await app.expectNotOwnBooking(b.bayId, b.endIdx + 1, b.endIdx + extraSlots);
  });
});

// ───────────────────────────── past midnight ─────────────────────────────

test.describe("Extend booking: past midnight @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let original: CreatedBooking | undefined;
  let extended: CreatedBooking | undefined;

  test("TC96: book the latest free slot of the day", async ({}, testInfo) => {
    requireBookingCreation();
    original = await bookFreeSlot(app, testInfo, { reuseOpenPage: true, rescheduleRoom: false, latestFirst: true, alsoFree: slotsAfterRequested(1) });
    suite.track(original);
    await app.viewMyBooking(original, { highlight: false });
  });

  test("TC97: extend it past 12:00 AM -> Booking Confirmed with the next-day end time; the saved booking is that long", async ({}, testInfo) => {
    test.skip(!original, "TC96 did not create a booking");
    const b = original!;
    const toMidnight = 96 - (b.endIdx + 1); // 15-min slots from the booking's end to 12:00 AM
    const need = toMidnight + 1; // one slot past midnight
    const popup = await openExtendPopup(app, b);
    const max = Number(await popup.getByRole("slider", { name: "Additional time" }).getAttribute("max"));
    testInfo.annotations.push({ type: "extend-max", description: `${max * 15} min after ${b.endTime}; ${need * 15} min needed to pass midnight` });
    if (max < need) {
      await app.page.keyboard.press("Escape");
      test.skip(true, `Only ${formatMinutes(max * 15)} free after ${b.endTime}, not enough to pass midnight`);
    }
    await stepExtendTo(app, popup, b, need); // from the default (+30 min)
    extended = await continueExtend(app, popup, b, need); // checks "Ends <next day> 12:15 AM" style label
    await confirmChangeDetails(app, testInfo, "extend", extended);
    suite.track(extended);

    // Saved on the backend: start unchanged, end the extra time later (past midnight)
    const saved = await app.fetchBooking(b.bookingId);
    const minutes = (new Date(saved.endTime).getTime() - new Date(saved.startTime).getTime()) / 60_000;
    expect(minutes, "booking length after the extension").toBe((b.endIdx - b.startIdx + 1 + need) * 15);
    await app.guidedClick(app.page.getByRole("button", { name: "View My Booking" }));
    await app.waitForBookingUi();
  });
});

// ───────────────────────────── session in progress ─────────────────────────────

test.describe("Extend booking: session in progress -> 'Extend session' button @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let live: CreatedBooking | undefined;

  test("TC98: book the current 15-min slot (the session is running at once)", async ({}, testInfo) => {
    requireBookingCreation();
    try {
      // Starts in the current 15-min slot (up to 14 min ago, still bookable), with 15 min free after it
      live = await bookFreeSlot(
        app,
        testInfo,
        { reuseOpenPage: true, tryNextDays: 0, rescheduleRoom: false, todayWindow: { min: -14, max: 0 }, alsoFree: slotsAfterRequested(1) },
        { attempts: 1 },
      );
    } catch (e) {
      if (testInfo.expectedStatus === "skipped") throw e;
      test.skip(true, `The current slot could not be booked: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    }
    suite.track(live!);
    await app.viewMyBooking(live!, { highlight: false });
  });

  test("TC99: the floating 'Extend session' button -> +15 min -> Extend details -> Booking Confirmed", async ({}, testInfo) => {
    test.skip(!live, "TC98 did not create a running session");
    const b = live!;
    await app.open(); // the button is shown for sessions running at the current location
    const button = app.page.getByRole("button", { name: /Extend session/ });
    await expect(button, "shown while a session is running").toBeVisible({ timeout: 30_000 });
    await app.guidedClick(button, { read: app.readMs });

    // Several running sessions: the app asks which one first
    const popup = app.dialog("additional time");
    if (!(await popup.isVisible({ timeout: 3000 }).catch(() => false))) {
      await app.guidedClick(app.page.getByRole("dialog").getByRole("button").filter({ hasText: b.startTime }).first());
    }
    await expect(popup).toBeVisible();
    await stepExtendTo(app, popup, b, 1); // the popup starts at +30 min when that is free
    const next = await continueExtend(app, popup, b, 1);
    await confirmChangeDetails(app, testInfo, "extend", next);
    suite.track(next);
    await app.viewMyBooking(next);
  });
});
