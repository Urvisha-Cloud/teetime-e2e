import type { TestInfo } from "@playwright/test";
import { type BaySlotState, type BookingApp, type CreatedBooking, type SelectedBooking, durationValue } from "../../support/booking-app";
import { env } from "../../support/env";
import { fromMinutes } from "../../support/time";
import {
  bookFreeSlot,
  bookingSuite,
  bookSlot,
  confirmNewBooking,
  expectConfirmed,
  formatMinutes,
  openExtendPopup,
  requireBookingCreation,
  slotsAfterRequested,
} from "../helper";
import { expect, test } from "../fixtures";

/**
 * Extend to another bay, the last card-paid part of npm test. Both cases: only 30 min free after the booking (another booking
 * starts then) -> Extend -> +30 min (the limit) -> a "book a new session" option -> pick a bay in the dropdown -> 1 hr
 * -> Continue -> Booking Details -> the new session on that bay is booked.
 *  TC19–21 "Switch bay, keep playing" (another bay of any kind)
 *  TC22–24 "Switch to Trackman" (the green promo; only offered when the booking is on an Impact Vision bay)
 * Main run, the last card-paid step (tests/main.spec.ts runs it after the card flow, quick shift and refund cases; wallet,
 * gift card and membership follow). npm run test:extend runs it alone.
 */

const GAP = 2; // 30 min free after the first booking
const HOUR = 4;

// Bay technology from /location/get-location-with-bays ("Impact Vision" or "Trackman", set in admin)
const isTech = (bay: { technology?: string }, tech: string) => bay.technology?.trim().toLowerCase() === tech;

/**
 * Books a free hour (never on `excludeBayIds`), then another booking in the same bay starting 30 min after it,
 * so the Extend popup stops at +30 min.
 */
async function bookWithBlockerAfter(
  app: BookingApp,
  testInfo: TestInfo,
  track: (b: CreatedBooking) => void,
  excludeBayIds: string[] = [],
) {
  const first = await bookFreeSlot(
    app,
    testInfo,
    { reuseOpenPage: true, rescheduleRoom: false, alsoFree: slotsAfterRequested(GAP + HOUR) },
    { excludeBayIds, cardOnly: true },
  );
  track(first);
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
  const blocker = await bookSlot(app, testInfo, sel);
  await expectConfirmed(app, blocker);
  await app.viewMyBooking(first, { highlight: false });
  await app.verifyBookingOnCalendar(blocker);
  return { first, blocker };
}

/** Extend popup on `f` -> "+30 min" (the limit) -> the "Need more than 30 min?" options are shown. */
async function extendToTheLimit(app: BookingApp, f: CreatedBooking) {
  const popup = await openExtendPopup(app, f);
  await expect(popup, "limit in the subtitle").toContainText(`Up to ${formatMinutes(GAP * 15)} available after your session`);
  // The other sessions are offered once the extra time is at the limit
  await app.guidedClick(popup.getByRole("button", { name: "+30 min", exact: true }), { read: app.readMs });
  await expect(popup).toContainText(`Need more than ${formatMinutes(GAP * 15)}? Book a new session`);
  return popup;
}

/**
 * The new-session view after an option was picked (subtitle "<option> · <bay>"): Bay dropdown -> pick one of
 * `freeBays` (the 2nd in the list when there are several, so the choice really changes) -> 1 hr -> preview -> Continue.
 * Then the calendar selects it and Booking Details opens. Returns the selected session.
 */
async function pickBayAndContinue(
  app: BookingApp,
  testInfo: TestInfo,
  f: CreatedBooking,
  option: string,
  freeBays: BaySlotState[],
): Promise<SelectedBooking> {
  const hour = { startIdx: f.endIdx + 1, endIdx: f.endIdx + HOUR };
  // The subtitle changes, so find the popup by its new text
  const picked = app.dialog("How long do you want to play?");
  await expect(picked).toBeVisible();
  await expect(picked).toContainText(`${option} ·`);
  const bayDropdown = picked.getByRole("combobox");
  await expect(bayDropdown).toBeVisible();
  await app.guidedClick(bayDropdown, { read: app.readMs });
  const options = app.page.getByRole("option");
  await expect(options.first()).toBeVisible();
  const texts = (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  const names = texts.map((t) => t.split("·")[0].trim());
  testInfo.annotations.push({ type: "bay-options", description: texts.join(" | ") });
  // The dropdown can also list bays that are not free for the whole hour (e.g. booked part of it), so pick one that
  // is in the dropdown AND free on the calendar — the 2nd such bay when there are several, so the choice changes
  const usable = names.filter((n) => freeBays.some((b) => b.bayName === n));
  expect(
    usable.length,
    `the dropdown (${names.join(", ")}) offers a bay free for the hour from ${f.endTime} (${freeBays.map((b) => b.bayName).join(", ")})`,
  ).toBeGreaterThan(0);
  const choice = usable[usable.length > 1 ? 1 : 0];
  const bay = freeBays.find((b) => b.bayName === choice);
  await app.guidedClick(options.filter({ hasText: choice }).first(), { read: app.readMs });
  await expect(bayDropdown).toContainText(choice);
  await expect(picked, "subtitle names the chosen bay").toContainText(`${option} · ${choice}`);

  // 1 hr from where the first booking ends, on the chosen bay
  const next: SelectedBooking = {
    ...f,
    bayId: bay!.bayId,
    bayName: bay!.bayName,
    startIdx: hour.startIdx,
    endIdx: hour.endIdx,
    startTime: f.endTime,
    endTime: fromMinutes((hour.endIdx + 1) * 15),
  };
  await expect(durationValue(picked, "session length"), "session length").toHaveText(formatMinutes(HOUR * 15));
  await expect(picked, "preview: bay and time").toContainText(`${next.bayName} · ${next.startTime} – ${next.endTime}`);
  await app.guidedClick(picked.getByRole("button", { name: /Continue/ }), { read: app.readMs });
  await expect(picked).toBeHidden();

  // Continue selects the new session on that bay, then the app opens Booking Details right away
  // (bay, time and date filled in); the header's Book Now is behind it, so check the modal instead.
  await app.expectSelection(next.bayId, next.startIdx, next.endIdx);
  const modal = app.modal();
  if (await modal.isVisible({ timeout: 5000 }).catch(() => false)) {
    await expect(modal.getByRole("heading", { name: "Booking Details" })).toBeVisible();
    await app.verifyModalDetails(modal, next); // location, time, date, the chosen bay
  } else {
    await app.verifySelectionHeader(next);
  }
  return next;
}

/** Booking Details (already open, or via Book Now) -> group size, waiver, payment -> Confirm -> Booking Confirmed. */
async function bookNewSession(app: BookingApp, testInfo: TestInfo, next: SelectedBooking, unchanged: CreatedBooking[]) {
  const modal = app.modal();
  let booked: CreatedBooking;
  if (await modal.isVisible().catch(() => false)) {
    await app.readPause();
    await app.selectGroupSize(modal, 1);
    booked = await confirmNewBooking(app, testInfo, modal, next); // waiver, card, Confirm -> Booking Confirmed -> email
    await app.readPause(env.showMs);
  } else {
    booked = await bookSlot(app, testInfo, next); // Book Now -> Booking Details -> …
    await expectConfirmed(app, booked);
  }
  await app.viewMyBooking(booked);
  // The first booking keeps its own time (not extended), the blocker is unchanged
  for (const b of unchanged) await app.verifyBookingOnCalendar(b);
  return booked;
}

// ───────────────────────────── Switch bay, keep playing ─────────────────────────────

test.describe("Extend to another bay: Switch bay, keep playing @card-switch-bay @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let first: CreatedBooking | undefined; // the booking we try to extend
  let blocker: CreatedBooking | undefined; // starts 30 min after it in the same bay
  let next: SelectedBooking | undefined; // the 1-hour session on the bay picked in the dropdown

  test("TC19: book a free hour, then another booking in the same bay starting 30 min after it", async ({}, testInfo) => {
    requireBookingCreation();
    ({ first, blocker } = await bookWithBlockerAfter(app, testInfo, (b) => suite.track(b)));
  });

  test("TC20: Extend -> +30 min (the limit) -> Switch bay, keep playing -> pick a bay in the dropdown -> 1 hr -> Continue", async ({}, testInfo) => {
    test.skip(!first || !blocker, "TC19 did not create both bookings");
    const f = first!;
    // Which other bays are free for the hour after the booking (what "Switch bay" can offer)
    const freeBays = (await app.baysForRange(f.endIdx + 1, f.endIdx + HOUR)).filter((x) => x.bayId !== f.bayId && x.free);
    testInfo.annotations.push({ type: "free-bays", description: `from ${f.endTime}: ${freeBays.map((b) => b.bayName).join(", ") || "none"}` });
    if (freeBays.length === 0) test.skip(true, `No other bay is free for an hour from ${f.endTime}, so Switch bay is not offered`);

    const popup = await extendToTheLimit(app, f);
    const switchBay = popup.getByRole("button").filter({ hasText: "Switch bay, keep playing" });
    await expect(switchBay).toBeVisible();
    await expect(switchBay).toContainText(`from ${f.endTime}`);
    await app.guidedClick(switchBay, { read: app.readMs });
    next = await pickBayAndContinue(app, testInfo, f, "Switch bay, keep playing", freeBays);
  });

  test("TC21: Booking Details -> group size, waiver, payment -> Confirm -> the new session on the other bay is booked", async ({}, testInfo) => {
    test.skip(!next, "TC20 did not select the new session");
    suite.track(await bookNewSession(app, testInfo, next!, [first!, blocker!]));
  });
});

// ───────────────────────────── Switch to Trackman ─────────────────────────────

test.describe("Extend to another bay: Switch to Trackman @card-switch-bay @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let trackmanIds: string[] = [];
  let first: CreatedBooking | undefined; // on an Impact Vision bay
  let blocker: CreatedBooking | undefined;
  let next: SelectedBooking | undefined; // the 1-hour session on the Trackman bay picked in the dropdown

  test("TC22: book a free hour on an Impact Vision bay, then another booking in the same bay starting 30 min after it", async ({}, testInfo) => {
    requireBookingCreation();
    await app.openIfNeeded();
    await app.loadLocations();
    const bays = app.api.location(env.locationName)?.bays ?? [];
    trackmanIds = bays.filter((b) => isTech(b, "trackman")).map((b) => b.id);
    const impactVision = bays.filter((b) => isTech(b, "impact vision"));
    testInfo.annotations.push({
      type: "bays",
      description: `Impact Vision: ${impactVision.map((b) => b.name).join(", ") || "none"}; Trackman: ${bays.filter((b) => isTech(b, "trackman")).map((b) => b.name).join(", ") || "none"}`,
    });
    test.skip(impactVision.length === 0 || trackmanIds.length === 0, `${env.locationName} needs both an Impact Vision and a Trackman bay`);
    // The booking must be on an Impact Vision bay: the Trackman option is only offered from there
    const notImpactVision = bays.filter((b) => !isTech(b, "impact vision")).map((b) => b.id);
    ({ first, blocker } = await bookWithBlockerAfter(app, testInfo, (b) => suite.track(b), notImpactVision));
  });

  test("TC23: Extend -> +30 min (the limit) -> Switch to Trackman -> pick a Trackman bay in the dropdown -> 1 hr -> Continue", async ({}, testInfo) => {
    test.skip(!first || !blocker, "TC22 did not create both bookings");
    const f = first!;
    // Trackman bays free for the hour after the booking
    const freeTrackman = (await app.baysForRange(f.endIdx + 1, f.endIdx + HOUR)).filter((x) => trackmanIds.includes(x.bayId) && x.free);
    testInfo.annotations.push({ type: "free-trackman", description: `from ${f.endTime}: ${freeTrackman.map((b) => b.bayName).join(", ") || "none"}` });
    if (freeTrackman.length === 0) test.skip(true, `No Trackman bay is free for an hour from ${f.endTime}, so Switch to Trackman is not offered`);

    const popup = await extendToTheLimit(app, f);
    // The green promo at the end of the options: "Want to keep playing? … Trackman bay(s) … free right after your session"
    await expect(popup).toContainText("Want to keep playing?");
    await expect(popup).toContainText(/Trackman bays? (\(.+\) )?(is|are) free/);
    await expect(popup).toContainText("right after your session");
    const toTrackman = popup.getByRole("button", { name: /Switch to Trackman/ });
    await expect(toTrackman).toBeVisible();
    await app.guidedClick(toTrackman, { read: app.readMs });
    next = await pickBayAndContinue(app, testInfo, f, "Switch to Trackman", freeTrackman);
  });

  test("TC24: Booking Details -> group size, waiver, payment -> Confirm -> the new session on the Trackman bay is booked", async ({}, testInfo) => {
    test.skip(!next, "TC23 did not select the new session");
    suite.track(await bookNewSession(app, testInfo, next!, [first!, blocker!]));
  });
});

