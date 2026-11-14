/** Small, dependency-free date/time helpers that mirror how the app formats things. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

/** Today's calendar date in an IANA timezone. */
export function todayIn(tz: string, now = new Date()): LocalDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function addDays(d: LocalDate, n: number): LocalDate {
  const dt = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}

export const isoDate = (d: LocalDate) =>
  `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

const weekday = (d: LocalDate) => WEEKDAYS[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()];

/** Calendar header text, e.g. "Oct 16 Fri" (CalenderHeader: MMM D ddd). */
export const headerLabel = (d: LocalDate) => `${MONTHS[d.month - 1]} ${d.day} ${weekday(d)}`;

/** Parse the calendar header ("Oct\n16\nFri") back into a date (year inferred near `ref`). */
export function parseHeaderLabel(text: string, ref: LocalDate): LocalDate | null {
  const m = text.replace(/\s+/g, " ").trim().match(/^([A-Z][a-z]{2}) (\d{1,2})/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]) + 1;
  if (month === 0) return null;
  let year = ref.year;
  if (ref.month === 12 && month === 1) year += 1;
  if (ref.month === 1 && month === 12) year -= 1;
  return { year, month, day: Number(m[2]) };
}

/** BookingModal.checkDate(): "Today" | "Tomorrow" | "ddd, D MMM". */
export function modalDateLabel(d: LocalDate, today: LocalDate): string {
  const diff = compareDates(d, today) / 86_400_000;
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return `${weekday(d)}, ${d.day} ${MONTHS[d.month - 1]}`;
}

/** BookingCheckout X(): "Today" | "Tomorrow" | "ddd, D MMM, YYYY". */
export function checkoutDateLabel(d: LocalDate, today: LocalDate): string {
  const diff = compareDates(d, today) / 86_400_000;
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return `${weekday(d)}, ${d.day} ${MONTHS[d.month - 1]}, ${d.year}`;
}

/** "8:00 PM" -> minutes after local midnight. */
export function toMinutes(time: string): number {
  const m = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) throw new Error(`Bad time "${time}" (expected e.g. "8:00 PM")`);
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "PM") h += 12;
  return h * 60 + Number(m[2]);
}

/** Minutes after local midnight -> "9:30 PM" (inverse of toMinutes; same day only). */
export function fromMinutes(minutes: number): string {
  if (minutes < 0 || minutes >= 24 * 60) throw new Error(`Time ${minutes} min is outside one day`);
  const h24 = Math.floor(minutes / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(minutes % 60).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

/** 15-minute grid indexes used by the calendar (buildTimeSlots): first and last slot of the range. */
export function slotRange(start: string, end: string): { startIdx: number; endIdx: number } {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (e <= s) throw new Error("Slot end must be after slot start on the same day");
  if (s % 15 || e % 15) throw new Error("Times must be on a 15-minute boundary");
  return { startIdx: s / 15, endIdx: e / 15 - 1 };
}

/** "8:00 PM" -> "08:00 PM" (checkout page uses hh:mm A). */
export const pad12 = (t: string) => t.replace(/^(\d):/, "0$1:");
