// Booking times: moving a booking, the free-slot search (selectRequestedSlot) and the slots that must also be free.
import type { TestInfo } from "@playwright/test";
import { BlockedError, BookingApp, type CalendarGrid, type CreatedBooking, type SelectedBooking, type SlotTimes } from "../../support/booking-app";
import { env } from "../../support/env";
import { type LocalDate, addDays, compareDates, fromMinutes, isoDate, nowMinutesIn, slotRange, todayIn, toMinutes } from "../../support/time";
import { test } from "../fixtures";
import { orBlocked } from "./suite";

/** The same booking (same day and bay) at a new time. */
export function atTime(b: CreatedBooking, startTime: string, endTime: string): CreatedBooking {
  return { ...b, ...slotRange(startTime, endTime), startTime, endTime };
}

/** The booking moved by `minutes` (quick shift: −15 / +15). */
export function shiftedBy(b: CreatedBooking, minutes: number): CreatedBooking {
  return atTime(b, fromMinutes(toMinutes(b.startTime) + minutes), fromMinutes(toMinutes(b.endTime) + minutes));
}

/** The booking made longer by `slots` × 15 minutes (extend). */
export function extendedBy(b: CreatedBooking, slots: number): CreatedBooking {
  // past midnight the end time is on the next day ("12:15 AM"); endIdx then runs past the day's 96 slots
  return { ...b, endIdx: b.endIdx + slots, endTime: fromMinutes((toMinutes(b.endTime) + slots * 15) % (24 * 60)) };
}

// ───────────────────────────── the time plan ─────────────────────────────
// No booking time is configured — only lengths: the booking (env.bookingMinutes, or selectRequestedSlot's
// bookingMinutes) and the reschedule time right after it (env.rescheduleMinutes). selectRequestedSlot finds the first
// start where everything a test needs is free and returns it as the selected booking; the later steps take their
// times from that booking (rescheduleTimes, shiftedBy, extendedBy …), never from shared state.
const SLOTS_PER_DAY = 96;
const bookingSlots = () => env.bookingMinutes / 15;
const rescheduleSlots = () => env.rescheduleMinutes / 15;
const at = (slot: number) => fromMinutes(slot * 15);

/** Slots relative to the booking start (0 = its first 15 min; negative = before it). */
export type RelativeSlots = { from: number; to: number };

/** The main flow's reschedule time: env.rescheduleMinutes right after booking `b` (up to 11:45 PM). */
export function rescheduleTimes(b: { endIdx: number }): SlotTimes {
  const end = b.endIdx + 1;
  return { startTime: at(end), endTime: at(Math.min(end + rescheduleSlots(), SLOTS_PER_DAY - 1)) };
}

/**
 * Start slots where the booking (`slots` long), `extra` and (with `rescheduleRoom`) the reschedule time all fit inside
 * one day. Earliest first, or latest first with `latestFirst` (a booking that ends as late as possible, e.g. to extend
 * it past midnight).
 */
function startSlots(slots: number, extra?: RelativeSlots, { rescheduleRoom = true, latestFirst = false } = {}): number[] {
  const lo = Math.min(0, extra?.from ?? 0);
  const hi = Math.max(slots + (rescheduleRoom ? rescheduleSlots() : 0), extra ? extra.to + 1 : 0); // exclusive
  const starts: number[] = [];
  // end stays before midnight (the grid and the times are one calendar day)
  for (let s = 0; s < SLOTS_PER_DAY; s++) if (s + lo >= 0 && s + hi <= SLOTS_PER_DAY - 1) starts.push(s);
  return latestFirst ? starts.reverse() : starts;
}

/** Steps 1–3: open site, select location, go to the booking date, pick a free bay, select the slot range. */
export async function selectRequestedSlot(
  app: BookingApp,
  testInfo: TestInfo,
  excludeBayIds: string[] = [],
  {
    reuseOpenPage = false,
    tryNextDays = 7,
    alsoFree,
    startWithin,
    rescheduleRoom = true,
    latestFirst = false,
    dayWindow,
    onlyDate,
    skipDay,
    bookingMinutes = env.bookingMinutes,
  }: {
    reuseOpenPage?: boolean;
    tryNextDays?: number;
    alsoFree?: RelativeSlots;
    /**
     * Only starts this many minutes from now (refund tiers). Counted across midnight, so late in the evening the
     * start can be after midnight on the next day (with tryNextDays >= 1).
     */
    startWithin?: { min: number; max: number };
    /** Keep the reschedule time (env.rescheduleMinutes) after the booking free too; false for tests that never reschedule. */
    rescheduleRoom?: boolean;
    latestFirst?: boolean;
    dayWindow?: { from: number; to: number };
    onlyDate?: LocalDate;
    skipDay?: (date: LocalDate) => string | null | undefined | false;
    /** Length of the booking (default env.bookingMinutes, 1 hr). */
    bookingMinutes?: number;
  } = {},
): Promise<SelectedBooking> {
  const slots = bookingMinutes / 15;
  return orBlocked(testInfo, async () => {
    await test.step("Open booking site", async () => {
      // reuseOpenPage: stay on the calendar that is already open instead of reloading it
      if (reuseOpenPage) await app.openIfNeeded();
      else await app.open();
    });
    await test.step(`Select location "${env.locationName}"`, async () => {
      await app.selectLocation(env.locationName);
      await app.verifyLocationData(env.locationName);
    });
    let date = onlyDate ?? app.targetDate();
    if (onlyDate) tryNextDays = 0;
    await test.step(`Go to booking date (+${env.daysAhead} day)`, async () => {
      await app.goToDate(date);
    });
    // The day's calendar, read once per day: every start time below is checked against it in memory
    let grid: CalendarGrid | undefined;
    const freeBay = async (start: number, times: SlotTimes) => {
      const extra = alsoFree && { startIdx: start + alsoFree.from, endIdx: start + alsoFree.to };
      grid ??= await app.readGrid();
      return app.findAvailableBay(date, times, excludeBayIds, extra, grid).catch((e) => {
        if (e instanceof BlockedError) return e;
        throw e;
      });
    };

    return test.step("Find the first free time and pick its bay", async () => {
      for (let day = 0; ; day++) {
        // The earliest time of the day where a bay is free for the booking and everything the test needs after it
        // A day the test cannot use (skipDay gives the reason) is passed over without looking at its times
        const skipReason = skipDay?.(date) || null;
        let found: Awaited<ReturnType<typeof freeBay>> = new BlockedError(skipReason ? `${isoDate(date)}: ${skipReason}` : `no start time fits on ${isoDate(date)}`);
        let times: SlotTimes = { startTime: "", endTime: "" };
        // Only starts at least TEETIME_MIN_LEAD_MINUTES from now (reschedule is blocked within 4 hours of the start),
        // or inside startWithin. Counted across midnight: "now" is in minutes from the start of `date`, negative on a
        // later day, so at 10 PM tomorrow's first allowed start is 2:30 AM, not 12:00 AM.
        const daysFromToday = Math.round(compareDates(date, todayIn(app.tz)) / 86_400_000);
        const now = nowMinutesIn(app.tz) - daysFromToday * 24 * 60;
        const earliest = now + (startWithin ? startWithin.min : env.minLeadMinutes); // <= 0 from the 2nd day on: any time
        const latest = startWithin ? now + startWithin.max : Infinity;
        for (const start of skipReason ? [] : startSlots(slots, alsoFree, { rescheduleRoom, latestFirst })) {
          if (start * 15 < earliest || start * 15 > latest) continue;
          if (dayWindow && (start * 15 < dayWindow.from || (start + slots) * 15 > dayWindow.to)) continue;
          times = { startTime: at(start), endTime: at(start + slots) };
          found = await freeBay(start, times);
          if (!(found instanceof BlockedError)) break;
        }
        if (!(found instanceof BlockedError)) {
          const reschedule = rescheduleTimes(slotRange(times.startTime, times.endTime));
          const msg =
            `free time on ${isoDate(date)}: ${times.startTime}–${times.endTime} in ${found.bayName}` +
            (rescheduleRoom ? ` (reschedule ${reschedule.startTime}–${reschedule.endTime})` : "");
          console.log(`[teetime-e2e] ${msg}`);
          testInfo.annotations.push({ type: "time", description: msg });
          if (day > 0) testInfo.annotations.push({ type: "date", description: `moved ${day} day(s) ahead to ${isoDate(date)}` });
          const sel = await app.selectRange(found, date, times);
          await app.verifySelectionHeader(sel);
          return sel;
        }
        const blocked = found;
        // 3. nothing free that day: next day via the calendar's › button (goToDate stops if the app blocks the date)
        if (day >= tryNextDays) throw blocked;
        if (skipReason) testInfo.annotations.push({ type: "date", description: `skipped ${isoDate(date)}: ${skipReason}` });
        console.log(
          `[teetime-e2e] ${skipReason ? `skipping ${isoDate(date)} (${skipReason})` : `no free time on ${isoDate(date)} at ${env.locationName}`}; trying the next day`,
        );
        date = addDays(date, 1);
        await app.goToDate(date);
        grid = undefined; // another day: read its calendar again
      }
    });
  });
}

// ───────────────────────────── slots that must also be free ─────────────────────────────
// For selectRequestedSlot's `alsoFree`: the bay picked for the booking time must be free here too, so the
// later change (extend, quick shift) is possible in that bay.

/** The `slots` × 15 min right after the booking (extend, 15 min later). */
export function slotsAfterRequested(slots: number): RelativeSlots {
  return { from: bookingSlots(), to: bookingSlots() + slots - 1 };
}

/** The `slots` × 15 min right before the booking (15 min earlier). */
export function slotsBeforeRequested(slots: number): RelativeSlots {
  return { from: -slots, to: -1 };
}

/** The reschedule time (right after the booking), plus `extraSlots` after it (e.g. the later extension). */
export function rescheduleSlotsRange(extraSlots = 0): RelativeSlots {
  return { from: bookingSlots(), to: bookingSlots() + rescheduleSlots() + extraSlots - 1 };
}
