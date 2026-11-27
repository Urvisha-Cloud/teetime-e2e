import type { TestInfo } from "@playwright/test";
import type { LocalDate } from "./time";

// Shared shapes of the booking tests: a bay's state, the calendar, a selected and a created booking.

export interface BaySlotState {
  bayId: string;
  bayName: string;
  free: boolean;
}

/** The rendered calendar of one day, read once: every bay and, per slot index, whether that slot can be booked. */
export interface CalendarGrid {
  bays: { bayId: string; bayName: string }[];
  /** free[bayId][slot]; a slot that is not rendered is missing (not free). */
  free: Record<string, boolean[]>;
}

export interface SelectedBooking {
  locationName: string;
  bayId: string;
  bayName: string;
  date: LocalDate;
  startIdx: number;
  endIdx: number;
  startTime: string; // "8:00 PM"
  endTime: string; // "9:00 PM"
}

/** A booking time on one day: "8:00 PM" – "9:00 PM". */
export type SlotTimes = { startTime: string; endTime: string };

export interface CreatedBooking extends SelectedBooking {
  bookingId: string;
  groupSize: number;
}

/** Thrown when the scenario cannot be executed because staging data does not allow it (not a product failure). */
export class BlockedError extends Error {}

/** Marks a test as blocked by dev data (no free slot, date not allowed …): shown in the report. */
export function annotateBlocked(testInfo: TestInfo, reason: string) {
  testInfo.annotations.push({ type: "blocked", description: reason });
}
