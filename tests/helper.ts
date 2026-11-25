import type { Locator, TestInfo } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { BlockedError, BookingApp, annotateBlocked, type CreatedBooking, type SelectedBooking } from "../support/booking-app";
import { bookingCreationBlockedReason, env } from "../support/env";
import { type LocalDate, addDays, compareDates, fromMinutes, headerLabel, isoDate, nowMinutesIn, pad12, slotRange, todayIn, toMinutes } from "../support/time";
import { expect, test, testUser } from "./fixtures";

type StripeCard = Parameters<BookingApp["enterCard"]>[1];
type ChangeKind = "reschedule" | "extend";

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

// ───────────────────────────── suite setup ─────────────────────────────

export function bookingSuite(onApp: (app: BookingApp) => void, { watch = false, timeout = 240_000 } = {}) {
  test.describe.configure({ mode: "serial", timeout });
  let app: BookingApp | undefined;
  let bookingId: string | undefined;
  let cancelled = false;

  test.beforeAll(async ({ sharedContext }) => {
    app = new BookingApp(sharedContext.pages()[0] ?? (await sharedContext.newPage()));
    app.watch = watch;
    onApp(app);
  });

  test.afterEach(async ({}, testInfo) => {
    if (app && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("failure.png", { body: await app.page.screenshot({ fullPage: true }), contentType: "image/png" });
    }
  });

  test.afterAll(async () => {
    if (app && bookingId && env.cleanup && !cancelled) {
      const res = await app.cancelBooking(bookingId);
      console.log(`[teetime-e2e] cleanup: cancel ${bookingId}: HTTP ${res.status}`);
    }
    app?.api.detach(); // the window stays open for the next tests; it is closed once at the end of the run
  });

  return {
    track(b: { bookingId: string }) {
      bookingId = b.bookingId;
    },
    markCancelled() {
      cancelled = true;
    },
  };
}

/** Skip creation tests unless staging + explicit opt-in. */
export function requireBookingCreation() {
  const reason = bookingCreationBlockedReason();
  test.skip(!!reason, reason ?? "");
}

/** Converts a staging-data problem (no free slot, date not allowed, no saved card) into a reported BLOCKED skip. */
export async function orBlocked<T>(testInfo: TestInfo, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BlockedError) {
      annotateBlocked(testInfo, e.message);
      test.skip(true, e.message);
    }
    throw e;
  }
}

// ───────────────────────────── the time plan ─────────────────────────────
// No booking time is configured — only lengths: the booking (env.bookingMinutes) and the reschedule time right after
// it (env.rescheduleMinutes). selectRequestedSlot finds the first start where everything a test needs is free and
// writes the times into `env`, so every later step (reschedule, extend, quick shift) follows them.
const SLOTS_PER_DAY = 96;
const bookingSlots = () => env.bookingMinutes / 15;
const rescheduleSlots = () => env.rescheduleMinutes / 15;

/** Slots relative to the booking start (0 = its first 15 min; negative = before it). */
export type RelativeSlots = { from: number; to: number };

/** Puts the booking at slot `start` of the day (and the reschedule time right after it) into `env`. */
function setPlan(start: number) {
  const at = (slot: number) => fromMinutes(slot * 15);
  const end = start + bookingSlots();
  Object.assign(env, {
    slotStart: at(start),
    slotEnd: at(end),
    rescheduleStart: at(end),
    rescheduleEnd: at(Math.min(end + rescheduleSlots(), SLOTS_PER_DAY - 1)), // only used when it fits (rescheduleRoom)
  });
}

/**
 * Start slots where the booking, `extra` and (with `rescheduleRoom`) the reschedule time all fit inside one day.
 * Earliest first, or latest first with `latestFirst` (a booking that ends as late as possible, e.g. to extend it
 * past midnight).
 */
function startSlots(extra?: RelativeSlots, { rescheduleRoom = true, latestFirst = false } = {}): number[] {
  const lo = Math.min(0, extra?.from ?? 0);
  const hi = Math.max(bookingSlots() + (rescheduleRoom ? rescheduleSlots() : 0), extra ? extra.to + 1 : 0); // exclusive
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
    todayWindow,
    rescheduleRoom = true,
    latestFirst = false,
    dayWindow,
    onlyDate,
    skipDay,
  }: {
    reuseOpenPage?: boolean;
    tryNextDays?: number;
    alsoFree?: RelativeSlots;
    todayWindow?: { min: number; max: number };
    rescheduleRoom?: boolean;
    latestFirst?: boolean;
    dayWindow?: { from: number; to: number };
    onlyDate?: LocalDate;
    skipDay?: (date: LocalDate) => string | null | undefined | false;
  } = {},
): Promise<SelectedBooking> {
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
    const freeBay = (start: number) => {
      setPlan(start);
      const extra = alsoFree && { startIdx: start + alsoFree.from, endIdx: start + alsoFree.to };
      return app.findAvailableBay(date, excludeBayIds, extra).catch((e) => {
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
        // Only starts at least TEETIME_MIN_LEAD_MINUTES from now (reschedule is blocked within 4 hours of the start).
        // Counted across midnight: at 10 PM, tomorrow's first allowed start is 2:30 AM, not 12:00 AM.
        const daysFromToday = Math.round(compareDates(date, todayIn(app.tz)) / 86_400_000);
        const isToday = daysFromToday === 0;
        const now = isToday ? nowMinutesIn(app.tz) : 0;
        const earliest = isToday
          ? now + (todayWindow ? todayWindow.min : env.minLeadMinutes)
          : nowMinutesIn(app.tz) + env.minLeadMinutes - daysFromToday * 24 * 60; // <= 0 from the 2nd day on: any time
        const latest = isToday && todayWindow ? now + todayWindow.max : Infinity;
        for (const start of skipReason ? [] : startSlots(alsoFree, { rescheduleRoom, latestFirst })) {
          if (start * 15 < earliest || start * 15 > latest) continue;
          if (dayWindow && (start * 15 < dayWindow.from || (start + bookingSlots()) * 15 > dayWindow.to)) continue;
          found = await freeBay(start);
          if (!(found instanceof BlockedError)) break;
        }
        if (!(found instanceof BlockedError)) {
          const msg =
            `free time on ${isoDate(date)}: ${env.slotStart}–${env.slotEnd} in ${found.bayName}` +
            ` (reschedule ${env.rescheduleStart}–${env.rescheduleEnd})`;
          console.log(`[teetime-e2e] ${msg}`);
          testInfo.annotations.push({ type: "time", description: msg });
          if (day > 0) testInfo.annotations.push({ type: "date", description: `moved ${day} day(s) ahead to ${isoDate(date)}` });
          const sel = await app.selectRange(found, date);
          await app.verifySelectionHeader(sel);
          return sel;
        }
        Object.assign(env, { slotStart: "", slotEnd: "", rescheduleStart: "", rescheduleEnd: "" });
        const blocked = found;
        // 3. nothing free that day: next day via the calendar's › button (goToDate stops if the app blocks the date)
        if (day >= tryNextDays) throw blocked;
        if (skipReason) testInfo.annotations.push({ type: "date", description: `skipped ${isoDate(date)}: ${skipReason}` });
        console.log(
          `[teetime-e2e] ${skipReason ? `skipping ${isoDate(date)} (${skipReason})` : `no free time on ${isoDate(date)} at ${env.locationName}`}; trying the next day`,
        );
        date = addDays(date, 1);
        await app.goToDate(date);
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

// ───────────────────────────── create ─────────────────────────────

/**
 * Book Now -> "Booking Details": group size, waiver and payment, ready for Confirm (not pressed).
 * `card`: type this Stripe test card instead of the TEETIME_PAYMENT_MODE payment (negative payment tests).
 */
export async function fillBookingModal(
  app: BookingApp,
  testInfo: TestInfo,
  sel: SelectedBooking,
  { groupSize = 1, card }: { groupSize?: number; card?: StripeCard } = {},
): Promise<Locator> {
  const modal = await app.openBookingModal(sel);
  await app.readPause(); // read the booking details
  await app.selectGroupSize(modal, groupSize);
  await app.scrollThrough(modal); // slowly down through the price to the waiver
  await app.acceptWaiver(modal);
  await orBlocked(testInfo, () => (card ? app.enterCard(modal, card) : app.preparePayment(modal)));
  return modal;
}

/** Fill the Booking Details modal and Confirm: POST /booking/:locationId/:bayId -> Booking Confirmed screen. */
export async function bookSlot(
  app: BookingApp,
  testInfo: TestInfo,
  sel: SelectedBooking,
  { groupSize = 1 }: { groupSize?: number } = {},
): Promise<CreatedBooking> {
  const modal = await fillBookingModal(app, testInfo, sel, { groupSize });
  const bookingId = await app.confirmBooking(modal, { read: Math.min(1500, app.readMs) }); // arrow on Confirm, then click
  testInfo.annotations.push({ type: "bookingId", description: bookingId });
  const booking = { ...sel, bookingId, groupSize };
  await showBookingEmail(app, testInfo, booking, "confirmed"); // YopMail window on top: the booking email, then behind
  return booking;
}

/**
 * Finds a free slot (selectRequestedSlot) and books it. If the booking cannot be created — the slot was taken in the
 * meantime, the API refused it, the confirmation never came — it cancels whatever that attempt created for the test
 * user (never anyone else's booking), reloads the calendar for fresh availability and picks again: `attempts` times
 * at most, then fails with the last error.
 */
export async function bookFreeSlot(
  app: BookingApp,
  testInfo: TestInfo,
  options: Parameters<typeof selectRequestedSlot>[3] = {},
  {
    groupSize = 1,
    attempts = 3,
    excludeBayIds = [],
  }: { groupSize?: number; attempts?: number; /** never book these bays (e.g. all but Impact Vision) */ excludeBayIds?: string[] } = {},
): Promise<CreatedBooking> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Retries reload the page, so the calendar shows the latest availability
    const sel = await selectRequestedSlot(app, testInfo, excludeBayIds, attempt === 1 ? options : { ...options, reuseOpenPage: false });
    const before = new Set(await app.myActiveBookingIds());
    try {
      return await bookSlot(app, testInfo, sel, { groupSize });
    } catch (e) {
      if (testInfo.expectedStatus === "skipped") throw e; // a deliberate skip (e.g. no way to pay), not a failed slot
      lastError = e;
      const reason = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160);
      // Only bookings that appeared during this attempt (the test user's own) are cancelled
      const created = (await app.myActiveBookingIds().catch(() => [] as string[])).filter((id) => !before.has(id));
      for (const id of created) {
        const res = await app.cancelBooking(id);
        console.log(`[teetime-e2e] cleanup after failed attempt: cancel ${id}: HTTP ${res.status}`);
      }
      const msg = `booking ${sel.startTime}–${sel.endTime} in ${sel.bayName} on ${isoDate(sel.date)} failed (attempt ${attempt}/${attempts}): ${reason}`;
      console.log(`[teetime-e2e] ${msg}${attempt < attempts ? "; trying another free slot" : ""}`);
      testInfo.annotations.push({ type: "retry", description: msg });
    }
  }
  throw new Error(`No booking could be created after ${attempts} attempts. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Booking Confirmed screen for `b` (time range, bay, persons; API cross-check), kept on screen for TEETIME_SHOW_MS. */
export async function expectConfirmed(app: BookingApp, b: CreatedBooking, { pause = true }: { pause?: boolean } = {}) {
  await expect(app.page).toHaveURL(new RegExp(`/book-slot/success\\?bookingId=${b.bookingId}`), { timeout: 30_000 });
  await app.verifyCheckout(b);
  // pause: false when the YopMail email step follows at once (it shows the result itself)
  if (pause) await app.page.waitForTimeout(env.showMs);
}

// ───────────────────────────── "Manage your booking" ─────────────────────────────

type ManageOption = "reschedule" | "group size" | "extend" | "cancel" | "15 min earlier" | "15 min later";

const MANAGE_OPTIONS: Record<ManageOption, (menu: Locator) => Locator> = {
  reschedule: (menu) => menu.getByRole("button", { name: /Reschedule/ }).filter({ hasText: "Choose a new time" }),
  "group size": (menu) => menu.getByRole("button", { name: /Update Group Size/ }),
  extend: (menu) => menu.getByRole("button", { name: /Extend Booking/ }),
  cancel: (menu) => menu.getByRole("button", { name: "Cancel booking", exact: true }), // red button in the footer
  "15 min earlier": (menu) => menu.getByRole("button", { name: "15 min earlier", exact: true }),
  "15 min later": (menu) => menu.getByRole("button", { name: "15 min later", exact: true }),
};

/** ⋮ on the booking -> "Manage your booking" -> `option` (it must be offered, i.e. enabled). */
export async function manageBooking(app: BookingApp, b: CreatedBooking, option: ManageOption) {
  const menu = await app.openManageMenu(b);
  const button = MANAGE_OPTIONS[option](menu);
  await expect(button, `"${option}" is offered for this booking`).toBeEnabled();
  await app.guidedClick(button, { read: app.readMs });
}

/**
 * Click `button` and wait for the app's PATCH /booking/<action>/<bookingId>: HTTP < 400, response noted in the report.
 */
export async function clickAndExpectPatch(
  app: BookingApp,
  testInfo: TestInfo,
  button: Locator,
  action: ChangeKind | "cancel",
  bookingId: string,
  { read = app.readMs }: { read?: number } = {},
) {
  const responsePromise = app.page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().startsWith(env.apiURL) && r.url().includes(`/booking/${action}/${bookingId}`),
    { timeout: 60_000 },
  );
  await app.guidedClick(button, { read });
  const response = await responsePromise;
  const body = await response.json().catch(() => ({}));
  testInfo.annotations.push({ type: `${action}-response`, description: `HTTP ${response.status()} ${JSON.stringify(body).slice(0, 200)}` });
  expect(response.status(), `${action} HTTP status (body: ${JSON.stringify(body).slice(0, 300)})`).toBeLessThan(400);
  return body;
}

/**
 * "Reschedule details" (reschedule, group-size update) or "Extend details" (extend) for the changed booking `b`:
 * group size (reschedule; `pickGroupSize` selects it here when it isn't selected yet), payment only when "You pay"
 * is above $0.00, waiver -> Confirm -> PATCH /booking/<kind>/:id -> Booking Confirmed for `b`.
 */
/** Pause between the keys when the gift card code is typed (ms), so it can be watched. */
export const GIFT_CODE_KEY_DELAY_MS = 150;

/**
 * "Have a gift card?" in Booking Details / Reschedule details -> `code` typed key by key -> Apply. Returns "You pay"
 * before and after. Nothing to pay -> the field is hidden: nothing is applied ({ before: 0, after: 0 }). The app
 * refuses the code (e.g. "Gift code balance exhausted") -> the test is skipped with that reason, before anything is
 * confirmed.
 */
export async function applyGiftCode(app: BookingApp, testInfo: TestInfo, modal: Locator, code: string) {
  const before = await app.amountToPay(modal);
  if (before <= 0) return { before, after: before };
  await app.guidedClick(modal.getByText(/Have a gift card\?/), { read: app.readMs });
  const field = modal.getByPlaceholder(/gift|code/i).or(modal.getByRole("textbox", { name: /gift|code/i })).first();
  await expect(field, "gift card code field").toBeVisible();
  // Typed key by key (visible while watching), not pasted in at once
  await app.guidedClick(field);
  await field.clear();
  await field.pressSequentially(code, { delay: GIFT_CODE_KEY_DELAY_MS });
  await app.guidedClick(modal.getByRole("button", { name: /^(Apply|Redeem|Use)/i }).first(), { read: app.readMs });

  // Applied: "You pay" goes down — or the app says why the code cannot be used
  const refused = modal.getByText(/balance exhausted|invalid|expired|not found|no balance|already used/i).first();
  let applied = false;
  for (const end = Date.now() + 15_000; Date.now() < end && !applied; ) {
    if (await refused.isVisible().catch(() => false)) {
      const why = (await refused.innerText()).trim();
      testInfo.annotations.push({ type: "gift-card", description: `${code}: ${why}` });
      test.skip(true, `The gift card code ${code} cannot be used ("${why}"): enter another code in the popup, or set a new TEETIME_GIFT_CARD_CODE in .env`);
    }
    applied = (await app.amountToPay(modal)) < before;
    if (!applied) await app.page.waitForTimeout(300);
  }
  expect(applied, `"You pay" lower than $${before.toFixed(2)} after applying the gift card`).toBe(true);
  await expect(modal, "gift card line in the price").toContainText(/gift card/i);
  return { before, after: await app.amountToPay(modal) };
}

/** How long the gift code popup waits for you to enter a code (ms). */
const GIFT_CODE_PROMPT_MS = 5 * 60_000;

/** Computed CSS of the first element of `loc` (`props` only); {} when it is not there. */
async function styleOf(loc: Locator, props: string[]): Promise<Record<string, string>> {
  return loc
    .first()
    .evaluate(
      (e, props) => {
        const s = getComputedStyle(e);
        return Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)]));
      },
      props,
      { timeout: 2_000 },
    )
    .catch(() => ({}));
}

/**
 * Shows a popup over the open modal (`modal`: Booking Details, Reschedule details, Redeem gift card) of the test
 * browser, on a dark overlay over the whole window, and waits for YOU to enter the gift card code to use (e.g. one
 * made in admin): type it, then "Apply this code" (or Enter). The field starts with `suggested` (empty unless given).
 * Returns the code, or "" when you press "Skip" (or nothing is entered within GIFT_CODE_PROMPT_MS). The modal behind
 * stays open: the popup keeps its clicks, focus and keys away from the modal's focus lock and close-on-outside.
 * It looks like the app: its card, heading, input and button styles are copied from the open modal (its own card,
 * heading, the time dropdowns and the Confirm button), with the app's theme colors as the fallback.
 */
export async function askGiftCode(
  app: BookingApp,
  testInfo: TestInfo,
  modal: Locator,
  {
    suggested = "",
    primaryButton,
    target = '"Have a gift card?"',
  }: {
    suggested?: string;
    /** The modal's main button, whose look "Apply this code" copies (default: Booking Details' Confirm). */
    primaryButton?: Locator;
    /** Where the test types the code, named in the popup's text. */
    target?: string;
  } = {},
): Promise<string> {
  testInfo.setTimeout(testInfo.timeout + GIFT_CODE_PROMPT_MS); // waiting for you does not count against the test
  console.log("[teetime-e2e] gift card: enter the code in the popup in the test browser");
  const theme = {
    card: await styleOf(modal, ["background-color", "color", "border-radius", "box-shadow", "font-family"]),
    title: await styleOf(modal.getByRole("heading"), ["font-size", "font-weight", "color"]),
    field: await styleOf(modal.getByRole("combobox").or(modal.getByRole("textbox")), ["border-top-color", "border-top-width", "border-radius", "background-color", "height"]),
    primary: await styleOf(primaryButton ?? app.confirmButton(modal), ["background-color", "background-image", "color", "border-radius", "font-weight", "box-shadow"]),
  };
  await modal.evaluate(
    (_modalEl, { suggested, theme, target }) => {
      (window as any).__teetimeGiftCode = undefined;
      document.getElementById("teetime-gift-prompt")?.remove();
      // A copied value, unless it is missing or see-through; then the app's theme variable (shadcn: --primary …)
      const pick = (value: string | undefined, fallback: string) =>
        value && value !== "none" && value !== "transparent" && !/^rgba\(\d+, \d+, \d+, 0\)$/.test(value) ? value : fallback;
      const t = theme as Record<string, Record<string, string>>;
      const vars: Record<string, string> = {
        "--g-card": pick(t.card["background-color"], "hsl(var(--card, 0 0% 100%))"),
        "--g-text": pick(t.card["color"], "hsl(var(--card-foreground, 215 28% 17%))"),
        "--g-muted": "hsl(var(--muted-foreground, 215 16% 47%))",
        "--g-radius": pick(t.card["border-radius"], "var(--radius, .75rem)"),
        "--g-shadow": pick(t.card["box-shadow"], "0 25px 50px -12px rgba(0,0,0,.25)"),
        "--g-font": pick(t.card["font-family"], "inherit"),
        "--g-title-size": pick(t.title["font-size"], "1.25rem"),
        "--g-title-weight": pick(t.title["font-weight"], "700"),
        "--g-title-color": pick(t.title["color"], "inherit"),
        "--g-border": pick(t.field["border-top-color"], "hsl(var(--input, 214 32% 91%))"),
        "--g-border-w": pick(t.field["border-top-width"], "1px"),
        "--g-field-radius": pick(t.field["border-radius"], "calc(var(--radius, .75rem) - 2px)"),
        "--g-field-bg": pick(t.field["background-color"], "hsl(var(--background, 0 0% 100%))"),
        "--g-field-h": pick(t.field["height"], "44px"),
        "--g-accent": pick(t.primary["background-color"], "hsl(var(--primary, 217 91% 60%))"),
        "--g-accent-image": pick(t.primary["background-image"], "none"),
        "--g-accent-text": pick(t.primary["color"], "hsl(var(--primary-foreground, 0 0% 98%))"),
        "--g-btn-radius": pick(t.primary["border-radius"], "var(--radius, .75rem)"),
        "--g-btn-weight": pick(t.primary["font-weight"], "600"),
        "--g-btn-shadow": pick(t.primary["box-shadow"], "none"),
      };
      const box = document.createElement("div");
      box.id = "teetime-gift-prompt";
      for (const [k, v] of Object.entries(vars)) box.style.setProperty(k, v);
      const P = "#teetime-gift-prompt";
      box.innerHTML = `
        <style>
          ${P}{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;
            background:rgba(15,23,42,.5);backdrop-filter:blur(2px);pointer-events:auto;font-family:var(--g-font);
            animation:tgFade .15s ease-out}
          ${P} *{box-sizing:border-box}
          ${P} .tg-card{background:var(--g-card);color:var(--g-text);border-radius:var(--g-radius);box-shadow:var(--g-shadow);
            padding:24px;width:min(400px,calc(100% - 32px));animation:tgPop .18s ease-out}
          ${P} .tg-head{display:flex;align-items:center;gap:12px;margin-bottom:8px}
          ${P} .tg-icon{flex:none;width:40px;height:40px;border-radius:9999px;display:grid;place-items:center;
            background:color-mix(in srgb,var(--g-accent) 14%,transparent);color:var(--g-accent)}
          ${P} .tg-title{margin:0;font-size:var(--g-title-size);font-weight:var(--g-title-weight);color:var(--g-title-color);line-height:1.25}
          ${P} .tg-text{margin:0 0 16px;font-size:14px;line-height:1.5;color:var(--g-muted)}
          ${P} label{display:block;font-size:14px;font-weight:500;margin-bottom:6px}
          ${P} input{width:100%;height:var(--g-field-h);padding:0 14px;font:inherit;font-size:16px;letter-spacing:1.5px;
            text-transform:uppercase;color:var(--g-text);background:var(--g-field-bg);border:var(--g-border-w) solid var(--g-border);
            border-radius:var(--g-field-radius);outline:none;transition:border-color .15s,box-shadow .15s}
          ${P} input::placeholder{color:var(--g-muted);letter-spacing:normal;text-transform:none}
          ${P} input:focus{border-color:var(--g-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--g-accent) 25%,transparent)}
          ${P} .tg-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
          ${P} button{height:44px;padding:0 20px;font:inherit;font-size:15px;font-weight:var(--g-btn-weight);
            border-radius:var(--g-btn-radius);cursor:pointer;transition:filter .15s,opacity .15s,background-color .15s}
          ${P} .tg-skip{background:transparent;color:var(--g-text);border:var(--g-border-w) solid var(--g-border)}
          ${P} .tg-skip:hover{background:color-mix(in srgb,var(--g-text) 6%,transparent)}
          ${P} .tg-ok{background-color:var(--g-accent);background-image:var(--g-accent-image);color:var(--g-accent-text);
            border:0;box-shadow:var(--g-btn-shadow)}
          ${P} .tg-ok:hover{filter:brightness(1.07)}
          ${P} .tg-ok:disabled{opacity:.5;cursor:not-allowed;filter:none}
          @keyframes tgFade{from{opacity:0}}
          @keyframes tgPop{from{opacity:0;transform:scale(.96)}}
        </style>
        <div class="tg-card" role="dialog" aria-modal="true" aria-labelledby="teetime-gift-title">
          <div class="tg-head">
            <span class="tg-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/>
                <path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5"/>
              </svg>
            </span>
            <h2 class="tg-title" id="teetime-gift-title">Gift card code</h2>
          </div>
          <p class="tg-text">Enter the gift card code to apply. The test types it into ${target} and continues.</p>
          <label for="teetime-gift-input">Code</label>
          <input id="teetime-gift-input" autocomplete="off" spellcheck="false" placeholder="e.g. GOLFXXXXXXXX" />
          <div class="tg-actions">
            <button id="teetime-gift-skip" class="tg-skip" type="button">Skip</button>
            <button id="teetime-gift-ok" class="tg-ok" type="button" disabled>Apply this code</button>
          </div>
        </div>`;
      // On the page itself (not inside the modal), so the overlay covers the whole window
      document.body.appendChild(box);
      const input = box.querySelector<HTMLInputElement>("#teetime-gift-input")!;
      const ok = box.querySelector<HTMLButtonElement>("#teetime-gift-ok")!;
      const sync = () => (ok.disabled = !input.value.trim()); // "Apply this code" only once a code is typed
      input.value = suggested;
      sync();
      input.addEventListener("input", sync);

      // The app's modal keeps focus inside itself and closes on a click, focus or Escape outside it. Events that
      // start in (or move focus into) the popup are stopped before the modal sees them, so you can click and type
      // here and the modal behind stays open. Enter in the field applies the code.
      const inBox = (n: EventTarget | null) => n instanceof Node && box.contains(n);
      const guarded = ["focusin", "focusout", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "keydown"];
      const guard = (e: Event) => {
        if (!inBox(e.target) && !inBox((e as FocusEvent).relatedTarget ?? null)) return;
        e.stopImmediatePropagation();
        const k = e as KeyboardEvent;
        if (k.type === "keydown" && k.key === "Enter" && k.target === input && input.value.trim()) done(input.value);
      };
      for (const type of guarded) window.addEventListener(type, guard, true);
      const done = (value: string) => {
        for (const type of guarded) window.removeEventListener(type, guard, true);
        (window as any).__teetimeGiftCode = value.trim().toUpperCase().replace(/[\s-]/g, "");
        box.remove();
      };
      ok.addEventListener("click", () => input.value.trim() && done(input.value));
      box.querySelector("#teetime-gift-skip")!.addEventListener("click", () => done(""));
      setTimeout(() => input.focus(), 50);
    },
    { suggested, theme, target },
  );
  const answered = await app.page
    .waitForFunction(() => (window as any).__teetimeGiftCode !== undefined, null, { timeout: GIFT_CODE_PROMPT_MS, polling: 300 })
    .then(() => true, () => false);
  const code = answered ? String(await app.page.evaluate(() => (window as any).__teetimeGiftCode)) : "";
  if (!answered) await app.page.evaluate(() => document.getElementById("teetime-gift-prompt")?.remove()).catch(() => {});
  testInfo.annotations.push({ type: "gift-card", description: code ? `${code} (entered in the popup)` : answered ? "skipped in the popup" : "no code entered in time" });
  return code;
}

/**
 * "Reschedule details" / "Extend details" -> … -> Booking Confirmed (see below). `giftCode`: apply it in the details
 * first ("Have a gift card?"), so the gift card pays the difference; returns "You pay" before and after it.
 */
export async function confirmChangeDetails(
  app: BookingApp,
  testInfo: TestInfo,
  kind: ChangeKind,
  b: CreatedBooking,
  { pickGroupSize = false, giftCode }: { pickGroupSize?: boolean; giftCode?: string } = {},
): Promise<{ before: number; after: number } | null> {
  const title = kind === "reschedule" ? "Reschedule details" : "Extend details";
  const details = app.dialog(title);
  await expect(details).toBeVisible({ timeout: 30_000 });
  if (kind === "extend") await expect(details, "new time range in the details").toContainText(`${b.startTime} - ${b.endTime}`);
  await app.readPause(); // read the new booking details
  if (kind === "reschedule") {
    // Clicking a size that is already selected could unselect it, so only click when it isn't
    const selected = /bg-green-600/.test((await app.groupSizeButton(details, b.groupSize).getAttribute("class")) ?? "");
    if (pickGroupSize && !selected) await app.selectGroupSize(details, b.groupSize);
    await app.verifyGroupSize(details, b.groupSize);
  }
  // The gift card pays (part of) the difference first, when one is given and something is due
  const gift = giftCode ? await applyGiftCode(app, testInfo, details, giftCode) : null;
  if (gift) testInfo.annotations.push({ type: "gift-card", description: `${title}: $${gift.before.toFixed(2)} -> $${gift.after.toFixed(2)} after the gift card` });
  await app.scrollThrough(details); // slowly down through the price breakdown to the waiver
  // The saved card ("Use Different Card") is shown even when nothing is due (e.g. "Previously paid" covers the
  // change), so only "You pay" decides whether a payment is needed.
  const toPay = await app.amountToPay(details);
  testInfo.annotations.push({ type: "you-pay", description: `${title}: $${toPay.toFixed(2)}` });
  if (toPay > 0) await orBlocked(testInfo, () => app.preparePayment(details));
  await app.acceptWaiver(details); // at the bottom of the scrolling modal

  const confirm = details.getByRole("button", { name: /^Confirm/ });
  await clickAndExpectPatch(app, testInfo, confirm, kind, b.bookingId, { read: Math.min(1500, app.readMs) });
  await expectConfirmed(app, b, { pause: false });
  // Straight from the checkout screen: YopMail window on top with the reschedule / group-size / extend email
  await showBookingEmail(app, testInfo, b, kind === "extend" ? "extended" : "rescheduled");
  return gift;
}

// ───────────────────────────── reschedule ─────────────────────────────

/** ⋮ -> Reschedule -> "How to Reschedule" (only once) -> Start rescheduling: the calendar is in reschedule mode. */
export async function startReschedule(app: BookingApp, b: CreatedBooking) {
  await manageBooking(app, b, "reschedule");
  const rules = app.dialog("How to Reschedule");
  await expect(rules).toBeVisible();
  await expect(rules).toContainText(/only once/i);
  await app.guidedClick(rules.getByRole("button", { name: /Start rescheduling/i }), { read: app.readMs });
  await expect(rules).toBeHidden();
  // Reschedule mode: the booking now shows its "Cancel Reschedule" button.
  await expect(app.cell(b.bayId, b.startIdx).getByTitle("Cancel Reschedule")).toBeVisible();
}

/** "Reschedule Booking" confirmation: the Current and the New time side by side. */
export async function rescheduleConfirmation(app: BookingApp): Promise<Locator> {
  const confirm = app.dialog("Reschedule Booking");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("Current");
  await expect(confirm).toContainText("New");
  return confirm;
}

/**
 * Reschedule mode: select startTime–endTime in the same bay -> header "Reschedule" -> "Reschedule Booking"
 * -> Confirm Changes ("Reschedule details" opens next). Returns the booking at the new time, same group size.
 */
export async function chooseNewTime(app: BookingApp, b: CreatedBooking, startTime: string, endTime: string): Promise<CreatedBooking> {
  const next = atTime(b, startTime, endTime);
  await app.selectSlots(b.bayId, next.startIdx, next.endIdx);
  await app.guidedClick(app.page.getByRole("button", { name: "Reschedule", exact: true }), { read: app.readMs }); // see the new time
  const confirm = await rescheduleConfirmation(app);
  await app.guidedClick(confirm.getByRole("button", { name: "Confirm Changes" }), { read: app.readMs }); // read current vs new
  await expect(confirm).toBeHidden();
  return next;
}

// ───────────────────────────── group size ─────────────────────────────

/**
 * ⋮ -> Update Group Size -> "Choose Number of Persons": smaller sizes disabled, "Add players" disabled until a larger
 * size is picked -> `newSize` -> Add players -> "Reschedule details" opens. Returns the booking with the new size.
 */
export async function addPlayers(app: BookingApp, b: CreatedBooking, newSize: number): Promise<CreatedBooking> {
  expect(newSize, "TEETIME_GROUP_SIZE_UPDATE must be larger than the booked group size (players can only be added)")
    .toBeGreaterThan(b.groupSize);
  await manageBooking(app, b, "group size");

  // Identify the popup by its own label: the "Reschedule details" modal that opens next has its own size buttons.
  const picker = app.dialog("Choose Number of Persons");
  await expect(picker).toBeVisible();
  for (let n = 1; n < b.groupSize; n++) {
    await expect(picker.getByRole("button", { name: String(n), exact: true }), `size ${n} is below the booked size`).toBeDisabled();
  }
  const add = picker.getByRole("button", { name: /^Add players/ });
  await expect(add, "disabled while the current group size is selected").toBeDisabled();
  await app.guidedClick(picker.getByRole("button", { name: String(newSize), exact: true }), { read: Math.min(1500, app.readMs) });
  await expect(add, "enabled after picking a larger group size").toBeEnabled();
  await app.guidedClick(add, { read: app.readMs }); // see the new group size selected
  await expect(picker).toBeHidden();
  await expect(app.dialog("Reschedule details"), "booking modal opens after Add players").toBeVisible({ timeout: 30_000 });
  return { ...b, groupSize: newSize };
}

// ───────────────────────────── extend ─────────────────────────────

/** ⋮ -> Extend Booking -> the "Extend Booking" popup (one value driven by slider, + / − and presets). */
export async function openExtendPopup(app: BookingApp, b: CreatedBooking): Promise<Locator> {
  await manageBooking(app, b, "extend");
  const popup = app.dialog("additional time");
  await expect(popup).toBeVisible();
  await expect(popup.getByRole("heading", { name: "Extend Booking" })).toBeVisible();
  return popup;
}

/** The popup shows "Ends <new end>" for `slots` extra -> Continue ("Extend details" opens next). Returns the longer booking. */
export async function continueExtend(app: BookingApp, popup: Locator, b: CreatedBooking, slots: number): Promise<CreatedBooking> {
  const ends = extendEndLabel(b, slots);
  await expect(popup, `"Ends ${ends}" for +${slots * 15} min`).toContainText(`Ends ${ends}`);
  await app.guidedClick(popup.getByRole("button", { name: /Continue/ }), { read: app.readMs }); // read the new end time
  await expect(popup).toBeHidden();
  return extendedBy(b, slots);
}

// ───────────────────────────── cancel ─────────────────────────────

// ───────────────────────────── refund policy ─────────────────────────────
// The cancellation refund rules, the same as the backend (getRefundPercentByTime) and the "How refunds work" list in
// the cancel popup (CancellationPolicyModal). New cancel scenarios reuse these: book a slot, openCancelDialog(),
// expectRefundShown(), then cancelInUi() or keepBooking().

/** Refund tiers, highest first: from `minMinutes` before the start, `percent` of what was paid comes back. */
export const REFUND_TIERS = [
  { minMinutes: 240, percent: 90, title: "90% refund", text: "More than 4 hours before the start time" },
  { minMinutes: 60, percent: 50, title: "50% refund", text: "Between 1 and 4 hours before the start time" },
  { minMinutes: 0, percent: 0, title: "No refund", text: "Within 1 hour of the start time" },
] as const;

/** Refund percent for a cancellation `minutesBeforeStart` before the booking starts. */
export const refundPercentFor = (minutesBeforeStart: number): number =>
  (REFUND_TIERS.find((t) => minutesBeforeStart >= t.minMinutes) ?? REFUND_TIERS[REFUND_TIERS.length - 1]).percent;

/** Minutes from now until `b` starts, in the location's time zone. */
export function minutesUntilStart(app: BookingApp, b: CreatedBooking): number {
  const days = compareDates(b.date, todayIn(app.tz)) / 86_400_000;
  return days * 24 * 60 + toMinutes(b.startTime) - nowMinutesIn(app.tz);
}

/** What the booking was paid with, in total: card + wallet + gift cards + membership credit (paymentBreakdown). */
export function paidTotal(booking: any): number {
  const p = booking?.paymentBreakdown;
  if (!p) return Number(booking?.paidAmount || 0);
  const gifts = (p.giftCards || []).reduce((sum: number, g: any) => sum + Number(g.amount || 0), 0);
  return Number(p.cardAmount || 0) + Number(p.walletAmount || 0) + gifts + Number(p.membershipCreditAmount || 0);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** ⋮ -> Cancel booking: the cancel popup (booking, refund, policy), not confirmed yet. */
export async function openCancelDialog(app: BookingApp, b: CreatedBooking): Promise<Locator> {
  await manageBooking(app, b, "cancel");
  const cancel = app.dialog("Confirm Cancellation");
  await expect(cancel).toBeVisible();
  await expect(cancel.getByRole("heading", { name: "Cancel Booking" })).toBeVisible();
  return cancel;
}

/**
 * The cancel popup shows the right refund for `b` right now:
 *  - "How refunds work" opens the three tiers (90% / 50% / no refund) and closes again
 *  - refund due: "Total refund (X%)" with paid × X%, a Card line when a card paid, the 10% fee note at 90%,
 *    and "Refunds are processed automatically"
 *  - nothing due: the "non-refundable" notice and no "Total refund"
 * Returns the expected percent and amount (also noted in the report).
 */
export async function expectRefundShown(app: BookingApp, testInfo: TestInfo, cancel: Locator, b: CreatedBooking) {
  const minutes = minutesUntilStart(app, b);
  const percent = refundPercentFor(minutes);
  const booking = await app.fetchBooking(b.bookingId);
  const paid = paidTotal(booking);
  const amount = round2((paid * percent) / 100);
  testInfo.annotations.push({ type: "refund", description: `${minutes} min before start: ${percent}% of $${paid.toFixed(2)} = $${amount.toFixed(2)}` });

  // The policy list
  const toggle = cancel.getByRole("button", { name: /How refunds work/ });
  await app.guidedClick(toggle);
  for (const tier of REFUND_TIERS) {
    await expect(cancel.getByText(tier.title, { exact: true }), `policy shows "${tier.title}"`).toBeVisible();
    await expect(cancel).toContainText(tier.text);
  }
  await app.readPause();
  await app.guidedClick(toggle);
  await expect(cancel.getByText(REFUND_TIERS[0].title, { exact: true }), "policy list closes again").toBeHidden();

  // The refund for this booking
  if (amount > 0) {
    await expect(cancel, "refund total").toContainText(`Total refund (${percent}%)`);
    await expect(cancel, "refund amount").toContainText(`$${amount.toFixed(2)}`);
    await expectRefundLines(cancel, booking, amount);
    if (percent === 90) await expect(cancel).toContainText("Includes a 10% payment processing and digital service fee");
    await expect(cancel).toContainText("Refunds are processed automatically");
  } else {
    await expect(cancel, "non-refundable notice").toContainText("non-refundable");
    await expect(cancel, "no refund total").not.toContainText("Total refund");
  }
  await app.readPause();
  return { percent, amount, minutes, paid };
}

/**
 * The cancel popup's refund lines, one per way the money goes back ("Gift card $27.00", "Card $3.00", "Wallet …"):
 * each is a way the booking was paid, and together they make the total refund. The app refunds a gift card first,
 * so a booking paid by gift card + card can show only a "Gift card" line (e.g. 90% of $27 + $3 = $27, all to the
 * gift card) — a "Card" line is not required just because the card paid part of it.
 */
async function expectRefundLines(cancel: Locator, booking: any, total: number) {
  const p = booking?.paymentBreakdown ?? {};
  const paidWith = {
    "Gift card": (p.giftCards ?? []).reduce((sum: number, g: any) => sum + Number(g.amount || 0), 0),
    Wallet: Number(p.walletAmount || 0),
    // No paymentBreakdown (older bookings): everything was paid by card
    Card: Number(booking?.paymentBreakdown ? p.cardAmount || 0 : booking?.paidAmount || 0),
  } as Record<string, number>;
  const text = await cancel.innerText();
  const refundPart = text.slice(text.indexOf("Total refund"));
  const lines = [...refundPart.matchAll(/^\s*(Gift card|Wallet[^\n$]*|Card)\s*\n?\s*\$(\d+(?:,\d{3})*\.\d{2})/gim)].map((m) => ({
    method: /^gift/i.test(m[1]) ? "Gift card" : /^wallet/i.test(m[1]) ? "Wallet" : "Card",
    amount: Number(m[2].replace(/,/g, "")),
  }));
  expect(lines.length, `refund lines in the cancel popup (${refundPart.slice(0, 200).replace(/\s+/g, " ")})`).toBeGreaterThan(0);
  for (const line of lines) {
    expect(paidWith[line.method], `the ${line.method} refund line is a way the booking was paid (${JSON.stringify(p)})`).toBeGreaterThan(0);
  }
  expect(round2(lines.reduce((sum, l) => sum + l.amount, 0)), "the refund lines add up to the total refund").toBeCloseTo(total, 2);
}

/** "Keep booking" in the cancel popup: it closes and the booking stays active. */
export async function keepBooking(app: BookingApp, cancel: Locator, b: CreatedBooking) {
  await app.guidedClick(cancel.getByRole("button", { name: "Keep booking", exact: true }), { read: app.readMs });
  await expect(cancel).toBeHidden();
  expect(await app.myActiveBookingIds(), "the booking is still active").toContain(b.bookingId);
}

/**
 * ⋮ -> Cancel booking -> "Cancel Booking" (refund policy) -> Confirm Cancellation -> PATCH /booking/cancel/:id ->
 * "Booking cancelled". `checkRefund`: first check the refund shown for this booking (expectRefundShown), then that
 * the backend applied it. `expectPercent`: the tier the popup must show, checked before Confirm (implies checkRefund).
 */
export async function cancelInUi(
  app: BookingApp,
  testInfo: TestInfo,
  b: CreatedBooking,
  { checkRefund = false, expectPercent }: { checkRefund?: boolean; expectPercent?: number } = {},
) {
  const cancel = await openCancelDialog(app, b);
  const expected = checkRefund || expectPercent !== undefined ? await expectRefundShown(app, testInfo, cancel, b) : null;
  if (expected && expectPercent !== undefined) {
    expect(expected.percent, `${expected.minutes} min before the start is the ${expectPercent}% tier`).toBe(expectPercent);
  }
  const body = await clickAndExpectPatch(app, testInfo, cancel.getByRole("button", { name: "Confirm Cancellation" }), "cancel", b.bookingId); // read the refund
  if (expected) {
    // The refund the backend actually applied follows the policy. The cancel response only carries a message, so the
    // amounts are read from the cancelled booking (metadata.refundAmount / cancellationFee, saved by the cancel).
    const after = await app.fetchBooking(b.bookingId);
    const refunded = Number(after?.metadata?.refundAmount ?? NaN);
    const fee = Number(after?.metadata?.cancellationFee ?? NaN);
    const message = String(body?.message ?? "");
    testInfo.annotations.push({
      type: "refund-applied",
      description:
        `refunded $${refunded.toFixed(2)}, fee $${fee.toFixed(2)} ` +
        `(expected ${expected.percent}% of $${expected.paid.toFixed(2)} = $${expected.amount.toFixed(2)}); "${message}"`,
    });
    expect(refunded, `refund applied: ${expected.percent}% of what was paid`).toBeCloseTo(expected.amount, 2);
    expect(fee, "cancellation fee = paid − refund").toBeCloseTo(round2(expected.paid - expected.amount), 2);
    // The API's message names the tier: 90% -> "partial refund (10% fee applied)", 50% -> "(50% fee applied)", 0% -> no refund
    if (expected.amount > 0) expect(message, "cancel message").toContain(`partial refund (${100 - expected.percent}% fee applied)`);
    else expect(message, "cancel message").not.toMatch(/refund \(/);
  }

  await expect(app.page.getByText("Booking cancelled")).toBeVisible();
  await expect(cancel).toBeHidden();
  await showBookingEmail(app, testInfo, b, "cancelled"); // YopMail window on top: the cancellation email, then behind
}

/** The cancelled booking is gone: no longer active for the user, and its slots on the calendar are free again. */
export async function expectBookingGone(app: BookingApp, b: CreatedBooking) {
  await app.goToDate(b.date);
  await expect
    .poll(async () => (await app.myActiveBookingIds()).includes(b.bookingId), {
      message: "cancelled booking still listed as active",
      timeout: 20_000,
    })
    .toBe(false);
  await app.expectNotOwnBooking(b.bayId, b.startIdx, b.endIdx);
  const bays = await app.baysForRange(b.startIdx, b.endIdx);
  expect(bays.find((x) => x.bayId === b.bayId)?.free, `${b.bayName} is free again`).toBe(true);
  await app.page.waitForTimeout(env.showMs);
}


// ───────────────────────────── extend popup controls ─────────────────────────────
// The "Extend booking" popup (ExtendBookingModal DurationPicker): one shared value in 15-min slots drives the
// slider, the + / − buttons, the presets, the "+45 min" label and "Ends …".

/** "45 min", "1 hr", "1 hr 15 min" — the app's formatMinutes(). */
export const formatMinutes = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
};

/** A quick pick of the popup ("+30 min", "+1 hr", … e.g. TEETIME_EXTEND_BY) in 15-minute slots: "+30 min" -> 2. */
export function presetSlots(label: string): number {
  const m = label.trim().match(/^\+(\d+)\s*(min|hr)$/i);
  const minutes = m ? Number(m[1]) * (m[2].toLowerCase() === "hr" ? 60 : 1) : NaN;
  if (!(minutes > 0 && minutes % 15 === 0)) {
    throw new Error(`TEETIME_EXTEND_BY="${label}" must be one of "+30 min", "+1 hr", "+2 hr", "+3 hr"`);
  }
  return minutes / 15;
}

/**
 * The popup's "Ends …" label for `base` + `slots`: "11:30 PM" on the same day, with the weekday once it passes
 * midnight ("Sun 12:30 AM") — the app's formatEnd(): "h:mm A" or "ddd h:mm A".
 */
export function extendEndLabel(base: CreatedBooking, slots: number): string {
  const total = toMinutes(base.endTime) + slots * 15;
  const time = fromMinutes(total % (24 * 60));
  if (total < 24 * 60) return time;
  const weekday = headerLabel(addDays(base.date, 1)).split(" ")[2]; // "Nov 15 Sun" -> "Sun"
  return `${weekday} ${time}`;
}

const slider = (popup: Locator) => popup.getByRole("slider", { name: "Additional time" });

/** The label, the slider position and "Ends …" all show `slots`; the original end time is still shown. */
async function expectExtendSelection(popup: Locator, base: CreatedBooking, slots: number) {
  await expect(popup.locator("div.text-2xl"), "additional time label").toHaveText(`+${formatMinutes(slots * 15)}`);
  await expect.poll(async () => Math.round(Number(await slider(popup).inputValue())), { message: "slider position" }).toBe(slots);
  await expect(popup, "new end time").toContainText(`Ends ${extendEndLabel(base, slots)}`);
  await expect(popup, "original end time shown (struck through)").toContainText(base.endTime);
}

/** Drag the slider with the mouse to `slots`, then fine-tune with the arrow keys if the drag landed a step off. */
async function dragExtendSlider(app: BookingApp, popup: Locator, slots: number, max: number) {
  const range = slider(popup);
  const box = await range.boundingBox();
  if (!box) throw new Error("extend slider not visible");
  const xFor = (value: number) => box.x + 8 + (box.width - 16) * (max > 1 ? (value - 1) / (max - 1) : 0);
  const y = box.y + box.height / 2;
  const current = Math.round(Number(await range.inputValue()));
  await app.page.mouse.move(xFor(current), y);
  await app.page.mouse.down();
  await app.page.mouse.move(xFor(slots), y, { steps: 12 }); // the label follows while dragging
  await app.page.mouse.up();
  for (let i = 0; i < 4; i++) {
    const now = Math.round(Number(await range.inputValue()));
    if (now === slots) break;
    await range.press(now < slots ? "ArrowRight" : "ArrowLeft");
  }
}

/**
 * Uses every way to pick the extra time and checks they always agree, then leaves `finalSlots` selected by
 * dragging the slider. Adapts to the maximum the popup offers (free time after the booking, up to 3 hr).
 *  start at +15 min ("−" disabled) · "+" up to +1 hr · "−" one step · every preset that fits · "+" to the maximum
 *  ("+" disabled; past midnight the end shows the weekday) · back to the minimum · slider drag to `finalSlots`
 * Returns the maximum in slots.
 */
export async function exerciseExtendControls(app: BookingApp, popup: Locator, base: CreatedBooking, finalSlots: number) {
  const plus = popup.getByRole("button", { name: "Add 15 minutes" });
  const minus = popup.getByRole("button", { name: "Remove 15 minutes" });
  const max = Number(await slider(popup).getAttribute("max"));
  expect(max, `the popup must offer at least ${formatMinutes(finalSlots * 15)}`).toBeGreaterThanOrEqual(finalSlots);
  await expect(popup, "slider's right end shows the maximum").toContainText(formatMinutes(max * 15));

  // Starts at the minimum
  await expectExtendSelection(popup, base, 1);
  await expect(minus, "− disabled at the minimum").toBeDisabled();
  await app.readPause();

  // "+" up to +1 hr (or the maximum), then "−" one step
  const up = Math.min(4, max);
  for (let i = 1; i < up; i++) await app.guidedClick(plus);
  await expectExtendSelection(popup, base, up);
  await app.readPause();
  if (up > 1) {
    await app.guidedClick(minus);
    await expectExtendSelection(popup, base, up - 1);
    await app.readPause();
  }

  // Every preset that fits: slider, label and end time move together
  let selected = up > 1 ? up - 1 : 1;
  for (const [label, slots] of [["+30 min", 2], ["+1 hr", 4], ["+2 hr", 8], ["+3 hr", 12]] as const) {
    if (slots > max) continue;
    await app.guidedClick(popup.getByRole("button", { name: label, exact: true }));
    await expectExtendSelection(popup, base, slots);
    selected = slots;
    await app.readPause();
  }

  // "+" to the maximum, where it is disabled
  while (selected < max) {
    await app.guidedClick(plus);
    selected++;
  }
  await expectExtendSelection(popup, base, max);
  await expect(plus, "+ disabled at the maximum").toBeDisabled();
  await app.readPause();

  // Back to the minimum (never below 15 min)
  if (max >= 2) {
    await app.guidedClick(popup.getByRole("button", { name: "+30 min", exact: true }));
    await expectExtendSelection(popup, base, 2);
    await app.guidedClick(minus);
  }
  await expectExtendSelection(popup, base, 1);
  await expect(minus, "− disabled at the minimum").toBeDisabled();
  await app.readPause();

  // Manual slider drag to the final choice
  await dragExtendSlider(app, popup, finalSlots, max);
  await expectExtendSelection(popup, base, finalSlots);
  await app.readPause();
  return max;
}

// ───────────────────────────── booking email (YopMail) ─────────────────────────────

/**
 * Timing of each email step, in order before the next step: the checkout screen -> TEETIME_EMAIL_ARRIVE_MS (default
 * 1 s) -> the inbox opens ONCE (one new tab), the window on top — YopMail opens the NEWEST email by itself — it loads
 * (YOPMAIL_LOAD_MS) and stays visible YOPMAIL_SHOW_MS (1 s) -> the window moves behind the test browser -> next step.
 * If the new email has not arrived by then, the newest one is still the PREVIOUS email (after create the last cancel
 * email or the login code, after a reschedule the create email, after a cancel the reschedule email) and the test
 * cannot click another email in that window: then raise TEETIME_EMAIL_ARRIVE_MS in .env (e.g. 10000).
 */
const YOPMAIL_LOAD_MS = 4_000;
const YOPMAIL_SHOW_MS = 1_000;

/** Which booking email the step after a change expects on top of the inbox (for the note and the console). */
type EmailKind = "confirmed" | "rescheduled" | "group size" | "extended" | "cancelled";
const EMAIL_SUBJECT: Record<EmailKind, string> = {
  confirmed: "Your TeeTime booking is confirmed",
  rescheduled: "Your TeeTime booking is rescheduled",
  "group size": "booking updated (group size)",
  extended: "booking extended",
  cancelled: "booking cancelled",
};

/** Your installed Google Chrome app, or undefined when it is not found. */
function chromeApp(): string | undefined {
  const candidates =
    process.platform === "win32"
      ? [
          path.join(process.env.PROGRAMFILES || "C:/Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] || "C:/Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  return candidates.find((p) => p && fs.existsSync(p));
}

/** The one YopMail window of this run (its Chrome process), kept open between the email steps. */
let yopmailWindow: ChildProcess | undefined;

/**
 * Show the newest email of the test user's YopMail inbox (e.g. teetime-e2e-…@yopmail.com) in a separate, NORMAL
 * Chrome window — not the test browser, where YopMail's Cloudflare check always fails.
 *
 * The YopMail window stays open for the whole run. Each call (after create, reschedule, group size, extend, cancel)
 * opens the inbox again in that window (a new tab, so it shows the newest email), puts the window ON TOP of the
 * test browser for the load time + 1 s, then moves it BEHIND the test browser and goes back to the booking site;
 * the next case runs and the next call brings the YopMail window to the top again. Closed it yourself? The next
 * call opens a new one. It stays open after the run; close it whenever you like.
 *
 * The window has its own small profile (.auth/yopmail-browser, git-ignored); the test never controls or reads the
 * page, so it does not check the email. Never skips or fails the test it runs in: when it cannot run (background
 * run, a test user that is not a YopMail address, no Chrome), it only adds a note.
 */
export async function showBookingEmail(app: BookingApp, testInfo: TestInfo, b: CreatedBooking, kind: EmailKind = "confirmed") {
  const skip = (why: string) => testInfo.annotations.push({ type: "booking-email", description: `${EMAIL_SUBJECT[kind]}: not shown (${why})` });
  const email = (testUser.email ?? env.testEmail).toLowerCase();
  if (!email.endsWith("@yopmail.com")) return skip(`the test user ${email || "(none)"} is not a YopMail address`);
  if (testInfo.project.use.headless !== false) return skip("visible runs only (--headed)");
  const chrome = chromeApp();
  if (!chrome) return skip("Google Chrome not found");

  const profile = path.join(path.dirname(env.storageState), "yopmail-browser");
  fs.mkdirSync(profile, { recursive: true });
  const inbox = `https://yopmail.com/en/?login=${encodeURIComponent(email.split("@")[0])}`;
  const look = `${b.startTime} – ${b.endTime}, ${b.bayName}`;

  const args = [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble", inbox];
  const openInbox = (): ChildProcess => {
    if (!yopmailWindow) {
      // First email of the run (or you closed the window): a new YopMail window
      const started = spawn(chrome, ["--start-maximized", "--new-window", ...args], { stdio: "ignore" });
      started.once("exit", () => {
        if (yopmailWindow === started) yopmailWindow = undefined;
      });
      yopmailWindow = started;
    } else {
      // Window already open: the same Chrome opens the inbox in a new tab there (shows the newest email)
      spawn(chrome, args, { stdio: "ignore" }).unref();
    }
    return yopmailWindow;
  };

  // In order, before the next step: checkout screen -> TEETIME_EMAIL_ARRIVE_MS (1 s) -> YopMail on top with this
  // step's email -> loaded + 1 s visible -> behind -> the test browser in front again -> the next step
  testInfo.annotations.push({ type: "booking-email", description: `${EMAIL_SUBJECT[kind]}: shown in YopMail (${inbox}; ${look})` });
  if (env.emailArriveMs > 0) await app.page.waitForTimeout(env.emailArriveMs);
  console.log(`[teetime-e2e] YopMail window on top: "${EMAIL_SUBJECT[kind]}" (${look})`);
  await moveWindow(openInbox().pid, "top");
  await app.page.waitForTimeout(YOPMAIL_LOAD_MS + YOPMAIL_SHOW_MS);
  await moveWindow(yopmailWindow?.pid, "behind");
  await app.page.bringToFront(); // back to the booking site tab
  await raiseTestWindow(app); // visibly in front again, even when another window such as VS Code was on top
}

/** Run a PowerShell script (Windows) and wait until it is done; errors are ignored (only window placement). */
function runPowerShell(script: string) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise<void>((resolve) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdio: "ignore", windowsHide: true });
    ps.once("exit", () => resolve());
    ps.once("error", () => resolve());
  });
}

/**
 * Windows only: bring the TEST browser's window to the front of every window. The window is found by a unique
 * marker put in the page title for a moment (the test browser's process is not otherwise known), raised with
 * user32 SetWindowPos (on top, then normal again, so it does not stay on top), and the page title restored.
 */
async function raiseTestWindow(app: BookingApp) {
  if (process.platform !== "win32") return;
  const marker = `TeeTimeE2E-${Date.now()}`;
  const title = await app.page.evaluate((m) => {
    const old = document.title;
    document.title = m;
    return old;
  }, marker).catch(() => null);
  if (title === null) return;
  await runPowerShell(
    [
      "$sig = @'",
      '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
      '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
      '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
      "'@",
      "$u = Add-Type -MemberDefinition $sig -Name WinRaise -Namespace TeeTimeE2E -PassThru",
      "for ($i = 0; $i -lt 25; $i++) {",
      `  $p = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${marker}*' } | Select-Object -First 1`,
      "  if ($p) { $h = $p.MainWindowHandle",
      "    if ($u::IsIconic($h)) { [void]$u::ShowWindow($h, 9) }",
      "    [void]$u::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x43); [void]$u::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x43); break }",
      "  Start-Sleep -Milliseconds 200",
      "}",
    ].join("\n"),
  );
  await app.page.evaluate((t) => (document.title = t), title).catch(() => {});
}

/**
 * Windows only: move the YopMail Chrome window (by its process id) to the top of every window ("top", always on
 * top while shown; restored first if minimized) or behind all other windows ("behind", no longer on top), with
 * user32 SetWindowPos. Waits until the window exists (up to 12 s). Nothing happens on other systems.
 */
async function moveWindow(pid: number | undefined, where: "top" | "behind") {
  if (process.platform !== "win32" || !pid) return;
  const action =
    where === "top"
      ? "if ($u::IsIconic($h)) { [void]$u::ShowWindow($h, 9) }; [void]$u::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x43)"
      : "[void]$u::SetWindowPos($h, [IntPtr](1), 0, 0, 0, 0, 0x13)";
  const script = [
    "$sig = @'",
    '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
    '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    "'@",
    "$u = Add-Type -MemberDefinition $sig -Name Win -Namespace TeeTimeE2E -PassThru",
    "for ($i = 0; $i -lt 60; $i++) {",
    `  $p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if (-not $p) { break }`,
    `  $h = $p.MainWindowHandle; if ($h -ne 0) { ${action}; break }`,
    "  Start-Sleep -Milliseconds 200",
    "}",
  ].join("\n");
  await runPowerShell(script);
}

// ───────────────────────────── Booking Details: End Time ─────────────────────────────

/**
 * The End Time dropdown's option for `endTime` (Booking Details). Near midnight the list runs into the next day, so
 * the same time can be listed twice (e.g. "2:00 AM" today and tomorrow): take the first one that can be picked —
 * the nearest end after the start.
 */
export function endTimeOption(app: BookingApp, endTime: string): Locator {
  return app.page.getByRole("option", { name: endTime, exact: true }).and(app.page.locator(":not([data-disabled])")).first();
}
