import type { BookingApp, CreatedBooking } from "../support/booking-app";
import { env } from "../support/env";
import { addPlayers, bookFreeSlot, bookingSuite, bookSlot, cancelInUi, chooseNewTime, confirmChangeDetails, continueExtend, exerciseExtendControls, expectBookingGone, expectConfirmed, openExtendPopup, presetSlots, requireBookingCreation, selectRequestedSlot, startReschedule, rescheduleSlotsRange } from "./helper";
import { expect, test, testUser } from "./fixtures";
import { slotRange } from "../support/time";

test.describe("Booking flow: login -> create -> reschedule -> group size -> extend -> cancel @main @creates-booking", () => {
  // Each step pauses to be read (TEETIME_READ_MS)
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let loggedIn = false;
  let booking: CreatedBooking | undefined; // the booking as it is after the latest step
  let rescheduled = false;
  let resized = false;
  let extended = false;
  const extraSlots = presetSlots(env.extendBy);

  test("TC42: login — new user signs up, or the existing user logs in", async ({}, testInfo) => {
    // The sign-up / login itself runs once per run in fixtures.ts (one Chrome window for every step).
    if (testUser.result) {
      const what = testUser.result === "signup" ? "new user created (sign up)" : "existing user logged in";
      testInfo.annotations.push({ type: "login", description: `${what}: ${testUser.email}` });
      console.log(`[teetime-e2e] TC42: ${what}: ${testUser.email}`);
    }
    // Login already ends on the booking calendar: use it as it is (no reload)
    await app.openIfNeeded();
    await expect(app.page.locator("input#email"), "no login popup: the user is signed in").toBeHidden();
    // An authorised API call works with the saved token (it fails when the user is signed out).
    const ids = await app.myActiveBookingIds();
    testInfo.annotations.push({ type: "active-bookings", description: String(ids.length) });
    loggedIn = true;
  });

  test("TC43: create — book the slot -> Booking Confirmed -> calendar", async ({}, testInfo) => {
    test.skip(!loggedIn, "TC42 login failed");
    requireBookingCreation();
    // First free time (today, else the next days); later steps need the same bay free for the reschedule time AND
    // the extension after it. A failed create is cleaned up and retried with another free slot.
    booking = await bookFreeSlot(app, testInfo, { reuseOpenPage: true, alsoFree: rescheduleSlotsRange(extraSlots) });
    suite.track(booking);
    await expectConfirmed(app, booking);
    await app.viewMyBooking(booking);
  });

  test(`TC44: reschedule — new time (the 2 hr after the booking), same group size -> Booking Confirmed -> calendar`, async ({}, testInfo) => {
    test.skip(!booking, "TC43 did not create a booking");
    await startReschedule(app, booking!);
    const after = await chooseNewTime(app, booking!, env.rescheduleStart, env.rescheduleEnd); // group size unchanged; TC45 changes it
    await confirmChangeDetails(app, testInfo, "reschedule", after, { pickGroupSize: true });
    booking = after;
    rescheduled = true;
    await app.viewMyBooking(booking);
  });

  test(`TC45: update group size — ${env.groupSizeUpdate} players -> Booking Confirmed -> calendar`, async ({}, testInfo) => {
    test.skip(!rescheduled, "TC44 did not reschedule the booking");
    const after = await addPlayers(app, booking!, env.groupSizeUpdate);
    await confirmChangeDetails(app, testInfo, "reschedule", after);
    booking = after;
    resized = true;
    await app.viewMyBooking(booking);
  });

  test(`TC46: extend — ${env.extendBy} -> Booking Confirmed with the new end time -> calendar`, async ({}, testInfo) => {
    test.skip(!resized, "TC45 did not update the group size");
    const popup = await openExtendPopup(app, booking!);
    // Slider, + / − and presets all drive one value; limits; ends with the slider on TEETIME_EXTEND_BY
    const max = await exerciseExtendControls(app, popup, booking!, extraSlots);
    testInfo.annotations.push({ type: "extend-max", description: `${max * 15} min` });
    const after = await continueExtend(app, popup, booking!, extraSlots);
    await confirmChangeDetails(app, testInfo, "extend", after);
    booking = after;
    extended = true;
    await app.viewMyBooking(booking);
  });

  test("TC47: cancel — Cancel booking -> Confirm cancellation -> calendar slots free again", async ({}, testInfo) => {
    test.skip(!extended, "TC46 did not extend the booking");
    await cancelInUi(app, testInfo, booking!, { checkRefund: true }); // policy shown + refund applied by the API
    suite.markCancelled();
    await expectBookingGone(app, booking!);
  });
});
