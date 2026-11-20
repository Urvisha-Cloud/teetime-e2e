import type { BookingApp, CreatedBooking } from "../support/booking-app";
import { env } from "../support/env";
import { slotRange } from "../support/time";
import {
  addPlayers,
  bookFreeSlot,
  bookingSuite,
  bookSlot,
  chooseNewTime,
  clickAndExpectPatch,
  confirmChangeDetails,
  expectConfirmed,
  manageBooking,
  requireBookingCreation,
  rescheduleConfirmation,
  selectRequestedSlot,
  shiftedBy,
  rescheduleSlotsRange,
  slotsAfterRequested,
  slotsBeforeRequested,
  startReschedule,
  showBookingEmail,
} from "./helper";
import { expect, test } from "./fixtures";

/**
 * Every reschedule case:
 *  TC27–34  reschedule to the 2 hours right after the booking (found at run time), then update the group size (one booking)
 *  TC48–53  quick shift from "Manage your booking": 15 min earlier / 15 min later (one booking each)
 * Each booking is cancelled afterwards (TEETIME_CLEANUP=true).
 */

test.describe("Reschedule a booking and update its group size @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a));
  let original: CreatedBooking | undefined;
  let rescheduled: CreatedBooking | undefined;
  let resized: CreatedBooking | undefined;

  // ───────────────────────────── reschedule ─────────────────────────────

  test("TC27: book the original slot", async ({}, testInfo) => {
    requireBookingCreation();
    // The new time must also be free in the same bay, or the reschedule cannot be tested.
    original = await bookFreeSlot(app, testInfo, { alsoFree: rescheduleSlotsRange() });
    suite.track(original);
    await app.viewMyBooking(original, { highlight: false });
  });

  test("TC28: ⋮ menu -> Manage your booking -> Reschedule -> Start rescheduling", async () => {
    test.skip(!original, "TC27 did not create a booking");
    await startReschedule(app, original!);
  });

  test("TC29: select the new time -> Reschedule -> confirmation -> Confirm Changes", async () => {
    test.skip(!original, "TC27 did not create a booking");
    const next = await chooseNewTime(app, original!, env.rescheduleStart, env.rescheduleEnd);
    // In "Reschedule details" (TC30) the group size is changed too, to TEETIME_RESCHEDULE_GROUP_SIZE.
    rescheduled = { ...next, groupSize: env.rescheduleGroupSize };
  });

  test(`TC30: Reschedule details -> group size ${env.rescheduleGroupSize} -> waiver -> Confirm -> Booking Confirmed with the new time and size`, async ({}, testInfo) => {
    test.skip(!rescheduled, "TC29 did not start the reschedule");
    await confirmChangeDetails(app, testInfo, "reschedule", rescheduled!, { pickGroupSize: true });
  });

  test("TC31: View My Booking -> calendar shows the booking at the new time", async () => {
    test.skip(!rescheduled, "TC29 did not start the reschedule");
    await app.viewMyBooking(rescheduled!);
    // The old time no longer belongs to this booking (unless it overlaps the new range).
    await app.expectNotOwnBooking(rescheduled!.bayId, original!.startIdx, original!.endIdx, rescheduled!);
  });

  // ───────────────────────────── update group size ─────────────────────────────

  test("TC32: ⋮ menu -> Manage your booking -> Update Group Size -> select size -> Add players", async () => {
    test.skip(!rescheduled, "TC29 did not start the reschedule");
    resized = await addPlayers(app, rescheduled!, env.groupSizeUpdate);
  });

  test("TC33: Reschedule details with the new group size -> waiver -> Confirm -> Booking Confirmed", async ({}, testInfo) => {
    test.skip(!resized, "TC32 did not start the group size update");
    // Already selected by "Add players": only checked here, not clicked
    await confirmChangeDetails(app, testInfo, "reschedule", resized!);
  });

  test("TC34: View My Booking -> calendar shows the booking with the new group size", async () => {
    test.skip(!resized, "TC32 did not start the group size update");
    await app.viewMyBooking(resized!); // also checks numberOfPersons from the API
  });
});

// ───────────────────────────── quick shift: 15 min earlier / later ─────────────────────────────

/** The backend needs time to finish moving the booking: stay on the Booking Confirmed screen this long before going on. */
const QUICK_SHIFT_SETTLE_MS = 1000;

for (const { minutes, label, first } of [
  { minutes: -15, label: "15 min earlier", first: 48 },
  { minutes: 15, label: "15 min later", first: 51 },
] as const) {
  test.describe(`Quick shift: ${label} @creates-booking`, () => {
    let app: BookingApp;
    const suite = bookingSuite((a) => (app = a), { watch: true });
    let original: CreatedBooking | undefined;
    let shifted: CreatedBooking | undefined;
    const shiftRoom = minutes < 0 ? slotsBeforeRequested(1) : slotsAfterRequested(1);

    test(`TC${first}: book the slot to move ${label}`, async ({}, testInfo) => {
      requireBookingCreation();
      // The 15 minutes the booking moves into must be free in the same bay too
      original = await bookFreeSlot(app, testInfo, { reuseOpenPage: true, alsoFree: shiftRoom });
      suite.track(original);
      await app.viewMyBooking(original, { highlight: false });
    });

    test(`TC${first + 1}: ⋮ -> "${label}" -> Reschedule booking shows current and new time -> Confirm changes -> Booking Confirmed`, async ({}, testInfo) => {
      test.skip(!original, `TC${first} did not create a booking`);
      // The 15 minutes must still be free right now (someone may have booked them since TC${first}). If not: cancel
      // this test booking, book another free slot that has the room, and shift that one — 3 tries at most.
      for (let attempt = 1; ; attempt++) {
        const room = minutes < 0 ? original!.startIdx - 1 : original!.endIdx + 1;
        const free = (await app.baysForRange(room, room)).find((x) => x.bayId === original!.bayId)?.free;
        if (free) break;
        if (attempt > 3) throw new Error(`The 15 minutes ${label} kept being taken by other bookings (3 new slots tried).`);
        console.log(`[teetime-e2e] the 15 min ${label} is no longer free for ${original!.startTime}–${original!.endTime}; booking another slot`);
        const res = await app.cancelBooking(original!.bookingId);
        console.log(`[teetime-e2e] cleanup: cancel ${original!.bookingId}: HTTP ${res.status}`);
        original = await bookFreeSlot(app, testInfo, { alsoFree: shiftRoom });
        suite.track(original);
        await app.viewMyBooking(original, { highlight: false });
      }
      const b = original!;
      const next = shiftedBy(b, minutes);

      // ⋮ on the booking -> "Manage your booking" -> Running early or late? -> 15 min earlier / later
      await manageBooking(app, b, label);

      // Confirmation: Current and New side by side, the new time 15 minutes earlier / later
      const confirm = await rescheduleConfirmation(app);
      for (const time of [b.startTime, b.endTime, next.startTime, next.endTime]) await expect(confirm).toContainText(time);
      await clickAndExpectPatch(app, testInfo, confirm.getByRole("button", { name: "Confirm Changes" }), "reschedule", b.bookingId);
      shifted = next;

      // Booking Checkout ("Booking Confirmed") with the new time, then wait for the reschedule to settle
      await expectConfirmed(app, next);
      await app.page.waitForTimeout(QUICK_SHIFT_SETTLE_MS);
      await showBookingEmail(app, testInfo, next, "rescheduled"); // YopMail window on top: the shift email, then behind
    });

    test(`TC${first + 2}: View My Booking -> calendar shows the booking at the new time`, async () => {
      test.skip(!shifted, `TC${first + 1} did not move the booking`);
      const b = shifted!;
      // Calendar: bay, new time and players from the API + calendar cells; the old 15 minutes no longer belong to it
      await app.viewMyBooking(b, { highlight: false });
      const freed = minutes < 0 ? original!.endIdx : original!.startIdx;
      await app.expectNotOwnBooking(b.bayId, freed, freed);
      await app.highlightBooking(b);
    });
  });
}
