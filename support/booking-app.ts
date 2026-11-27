import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { env } from "./env";
import { CURSOR_GLIDE_MS } from "./cursor";
import { ApiRecorder, unwrap } from "./network";
import { BookingApi } from "./booking-api";
import { BlockedError, type BaySlotState, type CalendarGrid, type CreatedBooking, type SelectedBooking, type SlotTimes } from "./booking-types";
import {
  addDays,
  checkoutDateLabel,
  compareDates,
  fromMinutes,
  headerLabel,
  isoDate,
  modalDateLabel,
  pad12,
  parseHeaderLabel,
  slotRange,
  todayIn,
  zonedToUtcMs,
  type LocalDate,
} from "./time";

// The shared types and BlockedError live in booking-types.ts; imported from here as before.
export * from "./booking-types";

/**
 * The one style class the tests still read: the calendar marks the user's OWN booking only by its green outline
 * (booking-ui CalenderGrid getBookingStyles: "before:border-green-600"; other people's bookings are gray). Only the
 * first slot of a booking has text, so there is nothing else on every slot to check. Kept here, in one place; a data
 * attribute on the slot in booking-ui (e.g. data-own-booking) would replace it.
 */
const OWN_BOOKING_STYLE = /before:border-green-600/;

/**
 * The big duration value of the extend / switch-bay picker (ExtendBookingModal DurationPicker: "+45 min", "1 hr"),
 * found by the caption right under it ("additional time" / "session length"), not by its font size.
 */
export function durationValue(popup: Locator, caption: "additional time" | "session length"): Locator {
  return popup.getByText(caption, { exact: true }).locator("xpath=preceding-sibling::*[1]");
}

/** Pages whose booking calendar was just loaded by the login step and not touched since (see markCalendarFresh). */
const freshCalendar = new WeakSet<Page>();

/**
 * The login step (tests/fixtures.ts) has just loaded the booking calendar in `page`: the first BookingApp.open()
 * uses it as it is instead of loading it a second time. Any navigation in the page (also inside the app) ends that,
 * so a later open() reloads as usual.
 */
export function markCalendarFresh(page: Page) {
  if (new URL(page.url()).pathname !== "/book-now") return;
  freshCalendar.add(page);
  const ended = (frame: unknown) => {
    if (frame !== page.mainFrame()) return;
    freshCalendar.delete(page);
    page.off("framenavigated", ended);
  };
  page.on("framenavigated", ended);
}

/**
 * Page object for the real booking UI (MonthStyleCalendarView + CalenderHeader + CalenderGrid + BookingModal).
 * Selectors are taken from the shipped source: data-slot / data-screen grid attributes, accessible
 * roles/names, and visible copy. The app has no data-testid attributes.
 */
export class BookingApp extends BookingApi {
  readonly api: ApiRecorder;
  readonly tz = env.browserTz;
  /**
   * Watched run: pause on each modal for TEETIME_READ_MS and scroll slowly through the price (see readMs).
   * Set by bookingSuite({ watch: true }) in tests/fixtures.ts; off for every other test.
   */
  watch = false;

  constructor(page: Page) {
    super(page);
    this.api = new ApiRecorder(page);
  }

  /** Reading pause for this run: TEETIME_READ_MS when watching, else 0 (no pauses). */
  get readMs(): number {
    return this.watch ? env.readMs : 0;
  }

  /** A dialog identified by text it contains (its title or a label). */
  dialog(name: string | RegExp): Locator {
    return this.page.getByRole("dialog").filter({ hasText: name });
  }

  // ───────────────────────────── navigation / auth ─────────────────────────────

  async open() {
    // Right after the login step the calendar is already freshly loaded: use it, no second load
    if (freshCalendar.has(this.page) && new URL(this.page.url()).pathname === "/book-now") {
      freshCalendar.delete(this.page);
      await this.openIfNeeded();
      return;
    }
    const since = Date.now();
    await this.page.goto("/book-now");
    await this.stayOnBookNow(since);
    await this.waitForBookingUi();
  }

  /**
   * Older booking-ui builds open My Booking on load when the user has a booking later today (removed from
   * LocationContext since), so after a login or a reload they can land on /my-bookings. The tests work on the Book Now calendar: wait
   * until the app has made that decision (its GET /booking/getMyBookings?every=true after `since`) and, if it
   * switched, go back with the sidebar's "Book Your Bay" — inside the app, because a reload would only switch again.
   */
  async stayOnBookNow(since: number) {
    const loginShown = this.page.locator("input#email");
    // An optional wait, so a plain loop: a timed-out expect.poll() would count as a test failure even when caught.
    // Short (3 s): booking-ui without that switch (removed there) never sends this request.
    for (const end = Date.now() + 3_000; Date.now() < end; ) {
      if (this.api.myBookingsLoadedAt >= since || new URL(this.page.url()).pathname === "/my-bookings") break;
      if (await loginShown.isVisible().catch(() => false)) break;
      await this.page.waitForTimeout(200);
    }
    await this.page.waitForTimeout(300); // the switch happens right after that response
    if (new URL(this.page.url()).pathname !== "/my-bookings") return;
    console.log("[teetime-e2e] the app opened My Booking (a booking later today); back to Book Now");
    await this.guidedClick(this.page.getByText("Book Your Bay", { exact: true }).first());
    await expect(this.page).toHaveURL(/\/book-now/);
  }

  /** Like open(), but keeps the page as it is when the booking calendar is already shown (e.g. right after login). */
  async openIfNeeded() {
    if (new URL(this.page.url()).pathname === "/book-now") {
      await this.waitForBookingUi();
      // The app fetched its location list and bookings during login, before this recorder listened: load them here
      if (this.api.locations.length === 0) await this.loadLocations();
      if (!this.api.lastBookingListUrl) await this.loadBookingList();
      return;
    }
    await this.open();
  }

  /** GET /location/get-location-with-bays (the same list the app uses). */
  async loadLocations() {
    const result = await this.authedFetch(`${env.apiURL}/location/get-location-with-bays`);
    expect(result.status, "GET /location/get-location-with-bays").toBe(200);
    const list = unwrap<any[]>(result.body);
    if (Array.isArray(list)) this.api.locations = list;
  }

  /**
   * GET /booking/get-every for the location shown in the header, with the same fromDate the calendar uses
   * on first load (yesterday, UTC midnight) — so the recorder has the bookings the app fetched at login.
   */
  async loadBookingList() {
    if (!(await this.locationButton().isVisible())) return;
    const loc = this.api.location(await this.currentLocationName());
    if (!loc) return; // no location yet (first-time user): selectLocation() makes the app fetch it
    const now = new Date();
    const fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString();
    const url = `${env.apiURL}/booking/get-every?locationId=${loc.id}&fromDate=${encodeURIComponent(fromDate)}`;
    const result = await this.authedFetch(url);
    expect(result.status, "GET /booking/get-every").toBe(200);
    const list = unwrap<any[]>(result.body);
    if (Array.isArray(list)) {
      this.api.lastBookingList = list;
      this.api.lastBookingListUrl = url;
    }
  }

  /** Booking UI is ready when either the grid or the "Select a Location" popup is shown. Fails on the login popup. */
  async waitForBookingUi() {
    const grid = this.page.locator('[data-slot="0"]').first();
    const pickLocation = this.page.getByRole("heading", { name: "Select a Location" });
    const login = this.page.locator("input#email");
    // The app can switch to My Booking on its own (e.g. a session in progress today), also later than stayOnBookNow
    // waits for: then go back to the calendar with the sidebar's "Book Your Bay" (a reload would only switch again)
    const myBookings = this.page.getByRole("heading", { name: "My Booking", exact: true });
    for (let attempt = 0; ; attempt++) {
      await expect(grid.or(pickLocation).or(login).or(myBookings)).toBeVisible({ timeout: 45_000 });
      if (attempt < 2 && new URL(this.page.url()).pathname === "/my-bookings" && !(await grid.isVisible())) {
        console.log("[teetime-e2e] the app opened My Booking; back to Book Now");
        await this.guidedClick(this.page.getByText("Book Your Bay", { exact: true }).first());
        await expect(this.page).toHaveURL(/\/book-now/);
        continue;
      }
      break;
    }
    if (await login.isVisible()) {
      throw new Error("Not authenticated: login popup shown. Run `npm run auth` to refresh the stored session.");
    }
  }

  /**
   * Log in with `email` through the login popup (LoginPopup.tsx), in this page — signing the user up first if the
   * email is unknown:
   *   existing user: email -> code screen -> type the code -> calendar                      => "login"
   *   unknown email (never created / deleted from the DB): email -> signup form (first/last name, 10-digit phone,
   *     default location) -> Continue sends the code -> type the code -> /user/completeProfile -> calendar => "signup"
   *   blocked account: email -> "We couldn't sign you in" (nothing else is done)              => "blocked"
   * The code must be the dev backend's fixed TEST_OTP (e.g. 1111).
   */
  async loginOrSignUp(details: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    locationName: string;
    otp: string;
  }): Promise<"login" | "signup" | "blocked"> {
    const page = this.page;
    const digits = details.otp.replace(/\D/g, "").split("");
    if (digits.length !== 4) throw new Error("TEETIME_TEST_OTP must be 4 digits (the dev backend's TEST_OTP, e.g. 1111).");

    await page.goto("/book-now");
    const emailInput = page.locator("input#email");
    await expect(emailInput, "login popup").toBeVisible({ timeout: 45_000 });
    await emailInput.fill(details.email);
    await this.guidedClick(page.getByRole("button", { name: "Continue", exact: true }));

    // POST /user/check-email decides the next screen: existing user -> code screen straight away;
    // unknown email (never created, or deleted from the DB) -> signup form; blocked account -> blocked screen.
    const codeHeading = page.getByRole("heading", { name: "Enter code to verify" });
    const firstName = page.getByPlaceholder("Enter your first name");
    const blocked = page.getByRole("heading", { name: "We couldn't sign you in" });
    await expect(codeHeading.or(firstName).or(blocked)).toBeVisible({ timeout: 30_000 });
    if (await blocked.isVisible()) return "blocked";

    let result: "login" | "signup" = "login";
    if (await firstName.isVisible()) {
      result = "signup";
      await firstName.fill(details.firstName);
      await page.getByPlaceholder("Enter your last name").fill(details.lastName);
      await page.getByPlaceholder("1234567890").fill(details.phone);
      await this.guidedClick(page.getByRole("combobox").filter({ hasText: "Select a location" }));
      await this.guidedClick(page.getByRole("option", { name: details.locationName }));
      await this.guidedClick(page.getByRole("button", { name: "Continue", exact: true }));
    }

    const since = Date.now(); // the app loads the user's bookings after the code is accepted
    // Code entry: 4 inputs with ids 1..4. The popup submits by itself once all 4 digits are entered
    // (LoginPopup.tsx useEffect -> onLogin), so "Verify & Login" is only clicked if the code screen is still up.
    await expect(codeHeading).toBeVisible({ timeout: 30_000 });
    for (let i = 0; i < 4; i++) await page.locator(`input[id="${i + 1}"]`).fill(digits[i]);
    const autoSubmitted = await codeHeading.waitFor({ state: "hidden", timeout: 10_000 }).then(() => true, () => false);
    if (!autoSubmitted) {
      const verify = page.getByRole("button", { name: "Verify & Login" });
      if (await verify.isVisible()) await this.guidedClick(verify);
    }

    // Logged in: popup closed, auth cookie set, booking calendar (or location picker) visible.
    await expect(emailInput.or(firstName)).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(async () => (await page.context().cookies()).some((c) => c.name === "authToken"), { message: "authToken cookie after login" })
      .toBe(true);
    await this.stayOnBookNow(since); // the app may open My Booking right after login
    await this.waitForBookingUi();
    return result;
  }

  /** The location switcher in the calendar header (desktop and mobile variants share the title attribute). */
  locationButton(): Locator {
    return this.page.locator('button[title="Change Location"]').filter({ visible: true }).first();
  }

  async currentLocationName(): Promise<string> {
    const text = await this.locationButton().locator("span").first().innerText();
    return text.trim();
  }

  /**
   * Step 2 — select a location through the existing UI:
   * header "Change Location" -> /location -> location card -> "Location Change" dialog -> "Change Location".
   */
  async selectLocation(name: string) {
    const popupHeading = this.page.getByRole("heading", { name: "Select a Location" });
    if (await popupHeading.isVisible()) {
      // First-time user: LocationSelectPopup on /book-now
      await this.guidedClick(this.page.locator(`p[title="${name}"]`));
      await this.confirmLocationChange(name);
    } else if ((await this.currentLocationName()) !== name) {
      await this.guidedClick(this.locationButton());
      await expect(this.page).toHaveURL(/\/location$/);
      const card = this.page.locator(`p[title="${name}"]`);
      await expect(card, `Location "${name}" must exist on /location`).toBeVisible();
      await this.guidedClick(card);
      await this.confirmLocationChange(name);
      await expect(this.page).toHaveURL(/\/book-now$/);
    }
    await expect(this.page.locator('[data-slot="0"]').first()).toBeVisible();
    await expect(this.locationButton()).toContainText(name);
  }

  private async confirmLocationChange(name: string) {
    const dialog = this.page.getByRole("dialog").filter({ hasText: "Location Change" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(name);
    await this.guidedClick(dialog.getByRole("button", { name: "Change Location" }));
  }

  /** Cross-checks the selected location against the app's own location API payload (timezone + bays). */
  async verifyLocationData(name: string) {
    await expect.poll(() => this.api.locations.length, { message: "location list API response" }).toBeGreaterThan(0);
    const loc = this.api.location(name);
    expect(loc, `"${name}" in /location/get-location-with-bays`).toBeTruthy();
    expect(loc!.timezone?.value, "TEETIME_BROWSER_TZ must equal the location timezone").toBe(this.tz);
    // The calendar must be loading bookings for this location.
    await expect
      .poll(() => this.api.lastBookingListUrl ?? "", { message: "get-every request for selected location" })
      .toContain(`locationId=${loc!.id}`);
    return loc!;
  }

  // ───────────────────────────── date navigation ─────────────────────────────

  private dateNav(): Locator {
    // Innermost block that holds the date <h2> and the prev/next chevron buttons (lucide icons), whatever its styling
    return this.page
      .locator("div")
      .filter({ has: this.page.locator("h2") })
      .filter({ has: this.page.locator("svg.lucide-chevron-left") })
      .last();
  }

  async displayedDate(): Promise<LocalDate> {
    const text = await this.dateNav().locator("h2").first().innerText();
    const parsed = parseHeaderLabel(text, todayIn(this.tz));
    if (!parsed) throw new Error(`Cannot parse calendar header date "${text}"`);
    return parsed;
  }

  targetDate(): LocalDate {
    return addDays(todayIn(this.tz), env.daysAhead);
  }

  /** Uses the real prev/next arrows (CalenderHeader). Throws BlockedError if the app does not allow that date. */
  async goToDate(target: LocalDate) {
    for (let i = 0; i < 14; i++) {
      const shown = await this.displayedDate();
      const diff = compareDates(target, shown);
      if (diff === 0) break;
      const btn = this.dateNav().locator(`button:has(svg.lucide-chevron-${diff > 0 ? "right" : "left"})`);
      if (await btn.isDisabled()) {
        throw new BlockedError(
          `Date ${isoDate(target)} is not bookable for this account (calendar arrow disabled; maxAccessDays limit).`,
        );
      }
      const before = await this.dateNav().locator("h2").first().innerText();
      await this.guidedClick(btn);
      await expect(this.dateNav().locator("h2").first()).not.toHaveText(before);
    }
    await expect(this.dateNav().locator("h2").first()).toHaveText(headerLabel(target), { useInnerText: true });
    await expect(this.page.locator('[data-slot="0"]').first()).toBeVisible();
  }

  // ───────────────────────────── grid / availability ─────────────────────────────

  /**
   * Reads the whole rendered calendar in one go: every bay column and every slot's state. A search over many start
   * times (selectRequestedSlot) reads it once per day and checks each range in memory instead of in the page.
   */
  async readGrid(): Promise<CalendarGrid> {
    await expect(this.page.locator('[data-slot="0"]').first()).toBeAttached();
    // Bay names from the app's own location data (GET /location/get-location-with-bays), by the column's bay id
    await expect
      .poll(() => this.api.location(env.locationName)?.bays?.length ?? 0, { message: `the bays of ${env.locationName} from the API` })
      .toBeGreaterThan(0);
    const names = new Map((this.api.location(env.locationName)?.bays ?? []).map((b) => [b.id, b.name]));
    const { ids, free } = await this.page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="0"]')).map((c) => c.getAttribute("data-screen")!);
      const free: Record<string, boolean[]> = Object.fromEntries(ids.map((id) => [id, [] as boolean[]]));
      for (const cell of Array.from(document.querySelectorAll<HTMLElement>("[data-screen][data-slot]"))) {
        const slots = free[cell.getAttribute("data-screen")!];
        const s = Number(cell.getAttribute("data-slot"));
        if (!slots || slots[s] !== undefined) continue; // the first cell of a slot counts (as document.querySelector)
        // The same rule as slotIsFree (below): clickable and showing no booking
        const before = getComputedStyle(cell, "::before").content;
        slots[s] = getComputedStyle(cell).cursor === "pointer" && (before === "none" || before === "normal");
      }
      return { ids, free };
    });
    return { bays: ids.map((bayId, i) => ({ bayId, bayName: names.get(bayId) ?? `bay#${i + 1}` })), free };
  }

  /**
   * A slot you can book: the app makes it clickable (cursor: pointer; past slots, other people's bookings and
   * inactive bays are "not-allowed") and draws no booking over it (a booking is a ::before layer). Read from the
   * computed style, not from class names, so a new color or Tailwind class does not change the answer. The user's own
   * booking is clickable too, but has the ::before layer.
   */
  async slotIsFree(bayId: string, slotIdx: number): Promise<boolean> {
    return this.cell(bayId, slotIdx).first().evaluate((cell) => {
      const before = getComputedStyle(cell, "::before").content;
      return getComputedStyle(cell).cursor === "pointer" && (before === "none" || before === "normal");
    });
  }

  /**
   * Every bay column's state for a slot range, straight from the rendered grid. `grid`: a calendar read earlier with
   * readGrid() (no page round trip); without it the page is read now.
   */
  async baysForRange(startIdx: number, endIdx: number, grid?: CalendarGrid): Promise<BaySlotState[]> {
    if (!grid) {
      await expect(this.page.locator(`[data-slot="${endIdx}"]`).first()).toBeAttached();
      grid = await this.readGrid();
    }
    const { free } = grid;
    return grid.bays.map(({ bayId, bayName }) => {
      let ok = true;
      for (let s = startIdx; s <= endIdx && ok; s++) ok = free[bayId][s] === true;
      return { bayId, bayName, free: ok };
    });
  }

  /** Server-side cross-check using the bookings the calendar itself loaded. */
  serverConflicts(bayId: string, date: LocalDate, startTime: string, endTime: string): any[] {
    const { startIdx, endIdx } = slotRange(startTime, endTime);
    return this.slotConflicts(bayId, date, startIdx, endIdx);
  }

  /**
   * Bookings in the app's own list (GET /booking/get-every) that overlap slots startIdx..endIdx of `date` in a bay,
   * compared in UTC — so slots past midnight (idx ≥ 96) and bookings that started the day before both count.
   */
  slotConflicts(bayId: string, date: LocalDate, startIdx: number, endIdx: number): any[] {
    const list = this.api.lastBookingList ?? [];
    const startMs = zonedToUtcMs(date, startIdx * 15, this.tz);
    const endMs = zonedToUtcMs(date, (endIdx + 1) * 15, this.tz);
    return list.filter((b: any) => {
      if (b.bayId !== bayId || b.isCancelled) return false;
      const bs = Date.parse(b.startTimeUTC);
      const be = Date.parse(b.endTimeUTC);
      return bs < endMs && be > startMs;
    });
  }

  /**
   * Step 3 — find a bay whose requested range is free. Throws BlockedError (never substitutes another time).
   */
  async findAvailableBay(
    date: LocalDate,
    times: SlotTimes,
    excludeBayIds: string[] = [],
    alsoFree?: { startIdx: number; endIdx: number },
    /** The day's calendar read once with readGrid() (a search over many start times); without it the page is read. */
    grid?: CalendarGrid,
  ): Promise<BaySlotState> {
    const { startIdx, endIdx } = slotRange(times.startTime, times.endTime);
    const bays = await this.baysForRange(startIdx, endIdx, grid);
    // alsoFree: the same bay must also be free for this range (e.g. the later reschedule + extend time)
    const extra = alsoFree ? await this.baysForRange(alsoFree.startIdx, alsoFree.endIdx, grid) : null;
    const candidate = bays.find(
      (b) =>
        b.free &&
        !excludeBayIds.includes(b.bayId) &&
        (!extra || extra.find((x) => x.bayId === b.bayId)?.free) &&
        this.serverConflicts(b.bayId, date, times.startTime, times.endTime).length === 0 &&
        // The extra range against the app's booking list too: the grid of a day does not show the part after
        // midnight of a booking that started the evening before, but the app refuses to book over it
        (!alsoFree || this.slotConflicts(b.bayId, date, alsoFree.startIdx, alsoFree.endIdx).length === 0),
    );
    if (!candidate) {
      const state = (b: BaySlotState) => {
        const also = extra?.find((x) => x.bayId === b.bayId)?.free;
        return `${b.bayName}:${b.free ? "free" : "taken"}${extra ? `/${also ? "free" : "taken"}` : ""}`;
      };
      const time = (idx: number) => (idx >= 96 ? "12:00 AM" : fromMinutes(idx * 15));
      const alsoText = alsoFree ? ` together with ${time(alsoFree.startIdx)}–${time(alsoFree.endIdx + 1)}` : "";
      throw new BlockedError(
        `BLOCKED: ${times.startTime}–${times.endTime}${alsoText} on ${isoDate(date)} is unavailable in every bay at ` +
          `${env.locationName} (${bays.map(state).join(", ")}).`,
      );
    }
    return candidate;
  }

  /** Shows a booking for env.showMs: scrolls it into view and pauses. Draws nothing over the app's own booking card. */
  async highlightBooking(b: { bayId: string; startIdx: number; endIdx: number }) {
    await this.cell(b.bayId, b.startIdx).scrollIntoViewIfNeeded();
    await this.page.waitForTimeout(env.showMs);
  }

  /** Pause so the current step can be read while watching (TEETIME_READ_MS; nothing when not watching or 0). */
  async readPause(ms = this.readMs) {
    if (ms > 0) await this.page.waitForTimeout(ms);
  }

  /**
   * One step of a watched run, always in this order:
   *  1. optional reading pause first (the arrow stays at the previous step, so it never looks like a click that hangs)
   *  2. the arrow glides onto the target (only when the visible cursor is on)
   *  3. click (or check) the moment it arrives: the action / API request starts at once — nothing waits after it.
   * The caller then waits for the next screen, so the next step starts only when it is really there.
   */
  async guidedClick(
    target: Locator,
    { read = 0, position, check = false }: { read?: number; position?: { x: number; y: number }; check?: boolean } = {},
  ) {
    if (read > 0) await this.page.waitForTimeout(read);
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeVisible();
    if (env.showCursor) {
      const box = await target.boundingBox();
      if (box) {
        const x = box.x + (position ? position.x : box.width / 2);
        const y = box.y + (position ? position.y : box.height / 2);
        await this.page.mouse.move(x, y);
        await this.page.waitForTimeout(CURSOR_GLIDE_MS); // click exactly when the arrow lands
      }
    }
    if (check) await target.check({ position });
    else await target.click({ position });
  }

  /**
   * Scrolls a modal slowly from top to bottom with the mouse wheel, the arrow resting over the modal, so its details
   * and price can be read (only when watching, and off when TEETIME_READ_MS=0).
   */
  async scrollThrough(modal: Locator) {
    if (this.readMs <= 0) return;
    // Scroll position of the modal's scrolling area, or -1 when it is already at the bottom (or cannot scroll)
    const position = () =>
      modal.evaluate((root) => {
        const scrollers = [root as HTMLElement, ...Array.from(root.querySelectorAll<HTMLElement>("*"))].filter(
          (el) => el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY),
        );
        const box = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
        return !box || box.scrollTop + box.clientHeight >= box.scrollHeight - 2 ? -1 : box.scrollTop;
      });
    const rect = await modal.boundingBox();
    if (!rect) return;
    await this.page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await this.page.waitForTimeout(CURSOR_GLIDE_MS);
    // Stops at the bottom, or when the wheel no longer moves it (e.g. the arrow is over a part that does not scroll)
    let last = await position();
    for (let stalled = 0, i = 0; last !== -1 && stalled < 3 && i < 60; i++) {
      await this.page.mouse.wheel(0, 60);
      await this.page.waitForTimeout(200);
      const now = await position();
      stalled = now === last ? stalled + 1 : 0;
      last = now;
    }
  }

  cell(bayId: string, slotIdx: number): Locator {
    return this.page.locator(`[data-screen="${bayId}"][data-slot="${slotIdx}"]`);
  }

  bookNowButton(): Locator {
    return this.page.getByRole("button", { name: /Book Now/ });
  }

  /**
   * Select slots startIdx..endIdx in one bay column: click the first slot, then the last one
   * (CalenderGrid.handleSlotClick extends the range), and check the whole range shows as selected.
   * Used for a new booking (selectRange) and for the new time while rescheduling.
   */
  async selectSlots(bayId: string, startIdx: number, endIdx: number) {
    await this.cell(bayId, startIdx).scrollIntoViewIfNeeded();
    await this.guidedClick(this.cell(bayId, startIdx), { position: { x: 12, y: 12 } });
    await this.guidedClick(this.cell(bayId, endIdx), { position: { x: 12, y: 12 } });
    await this.expectSelection(bayId, startIdx, endIdx);
  }

  /**
   * The calendar shows slots startIdx..endIdx of a bay as the current selection: the app writes its time range
   * ("8:00 PM – 9:00 PM", with the minutes) into the selection.
   */
  async expectSelection(bayId: string, startIdx: number, endIdx: number) {
    const label = `${fromMinutes(startIdx * 15)} – ${fromMinutes((endIdx + 1) * 15)}`;
    await expect(this.page.locator(`[data-screen="${bayId}"]`).getByText(label).first(), `the selection ${label}`).toBeVisible();
  }

  /** Select `times` (found by selectRequestedSlot) in `bay`. */
  async selectRange(bay: BaySlotState, date: LocalDate, times: SlotTimes): Promise<SelectedBooking> {
    const { startIdx, endIdx } = slotRange(times.startTime, times.endTime);
    await this.selectSlots(bay.bayId, startIdx, endIdx);
    return {
      locationName: env.locationName,
      bayId: bay.bayId,
      bayName: bay.bayName,
      date,
      startIdx,
      endIdx,
      startTime: times.startTime,
      endTime: times.endTime,
    };
  }

  /** Step 3 assertions: grid selection label + Book Now button state. */
  async verifySelectionHeader(sel: SelectedBooking) {
    const minutes = (sel.endIdx - sel.startIdx + 1) * 15;
    const column = this.page.locator(`[data-screen="${sel.bayId}"]`);
    await expect(column.getByText(`${sel.startTime} – ${sel.endTime}`, { exact: false })).toBeVisible();
    await expect(column.getByText(`(${minutes} min)`)).toBeVisible();
    await expect(this.bookNowButton()).toBeVisible();
    await expect(this.bookNowButton()).toBeEnabled();
    await expect(this.bookNowButton()).toContainText(/\$\d+\.\d{2}/);
  }

  // ───────────────────────────── booking modal ─────────────────────────────

  modal(): Locator {
    return this.page.getByRole("dialog").filter({ hasText: "Booking Details" });
  }

  async openBookingModal(sel: SelectedBooking): Promise<Locator> {
    const postsBefore = this.api.createRequests.length;
    await this.guidedClick(this.bookNowButton());
    const modal = this.modal();
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("heading", { name: "Booking Details" })).toBeVisible();
    await this.verifyModalDetails(modal, sel);
    expect(this.api.createRequests.length, "opening the modal must not create a booking").toBe(postsBefore);
    await expect(this.page).toHaveURL(/\/book-now$/);
    return modal;
  }

  async verifyModalDetails(modal: Locator, sel: SelectedBooking) {
    await expect(modal).toContainText(sel.locationName);
    await expect(modal).toContainText(`${sel.startTime} - ${sel.endTime}`);
    await expect(modal).toContainText(modalDateLabel(sel.date, todayIn(this.tz)));
    // Bay <Select> trigger shows the selected bay; start/end time selects show the range.
    const combos = modal.getByRole("combobox");
    await expect(combos.nth(0)).toHaveText(sel.bayName);
    await expect(combos.nth(1)).toHaveText(sel.startTime);
    await expect(combos.nth(2)).toHaveText(sel.endTime);
    await expect(modal.getByText("Select Group Size")).toBeVisible();
    await expect(this.confirmButton(modal)).toBeVisible();
  }

  groupSizeButton(modal: Locator, n: number): Locator {
    return modal.getByRole("button", { name: String(n), exact: true });
  }

  async selectGroupSize(modal: Locator, n: number) {
    await this.guidedClick(this.groupSizeButton(modal, n));
    await this.verifyGroupSize(modal, n);
  }

  async verifyGroupSize(modal: Locator, n: number) {
    // The group size buttons mark the chosen one only by color; the price says it in words: PricingWaterfall
    // subtitle "Includes N person(s)" + capacity note
    await expect(modal).toContainText(new RegExp(`Includes (discounts and )?${n} person${n > 1 ? "s" : ""}`));
    await expect(modal).toContainText(n <= 3 ? "Max 3 persons allowed per bay" : "Max 5 persons allowed per bay");
  }

  /**
   * The "You pay" amount in a booking / reschedule modal, in dollars. The row can show a struck-through original
   * price before the real one (e.g. "$21.73 $0.00"), so the LAST amount in the row is used.
   */
  async amountToPay(modal: Locator): Promise<number> {
    const text = await modal.innerText();
    const start = text.indexOf("You pay");
    if (start < 0) throw new Error('No "You pay" amount in the modal');
    const row = text.slice(start, start + 160).split(/Session price|Max \d persons/)[0];
    const amounts = [...row.matchAll(/\$(\d+(?:,\d{3})*\.\d{2})/g)].map((m) => Number(m[1].replace(/,/g, "")));
    if (!amounts.length) throw new Error(`Could not read the "You pay" amount from: ${row}`);
    return amounts[amounts.length - 1];
  }

  waiverCheckbox(modal: Locator): Locator {
    return modal.getByRole("checkbox");
  }

  confirmButton(modal: Locator): Locator {
    return modal.getByRole("button", { name: /^Confirm/ });
  }

  async acceptWaiver(modal: Locator) {
    const box = this.waiverCheckbox(modal);
    await this.guidedClick(box, { check: true });
    await expect(box).toBeChecked();
    await expect(modal.getByText("You must agree to the waiver before confirming your booking.")).toHaveCount(0);
  }

  /**
   * Payment section. Staging Stripe runs in TEST mode (pk_test_). Either the test account already has a saved
   * card ("**** **** **** 1234" + "Use Different Card"), or we type a Stripe published test card.
   */
  async preparePayment(modal: Locator) {
    const savedCard = modal.getByRole("button", { name: "Use Different Card" });
    const hasSaved = await savedCard.isVisible();
    if (env.paymentMode === "saved-card") {
      if (!hasSaved) {
        // Price fully covered by wallet/gift needs no card; otherwise we cannot proceed safely.
        const total = await modal.getByText(/^\$\d+\.\d{2}$/).last().innerText().catch(() => "");
        if (total !== "$0.00") {
          throw new BlockedError(
            "Test account has no saved card. Save a Stripe test card on the account or use TEETIME_PAYMENT_MODE=test-card.",
          );
        }
      }
      return;
    }
    // A new booking (Booking Details): "Use Different Card" -> the test card is typed. Changes of a booking (Reschedule /
    // Extend details) use the saved card: every typed card stays attached to the Stripe customer, and Stripe allows
    // only so many per customer ("already has the maximum number of payment methods attached")
    const newBooking = await modal.getByRole("heading", { name: "Booking Details" }).isVisible();
    if (hasSaved && !newBooking) return;
    await this.enterCard(modal, env.stripe);
  }

  /**
   * Type a card into the Stripe card fields of the booking modal (switching from a saved card first if one is shown).
   * Only Stripe's published TEST card numbers belong here (dev Stripe runs in test mode).
   */
  async enterCard(modal: Locator, card: { card: string; exp: string; cvc: string; zip: string }) {
    const savedCard = modal.getByRole("button", { name: "Use Different Card" });
    if (await savedCard.isVisible()) await this.guidedClick(savedCard);
    await modal.frameLocator('iframe[title*="card number" i]').locator('input[name="cardnumber"]').pressSequentially(card.card);
    await modal.frameLocator('iframe[title*="expiration" i]').locator('input[name="exp-date"]').pressSequentially(card.exp);
    await modal.frameLocator('iframe[title*="CVC" i]').locator('input[name="cvc"]').pressSequentially(card.cvc);
    const zip = modal.getByPlaceholder("12345");
    await zip.fill(card.zip);
  }

  // ───────────────────────────── confirm / checkout ─────────────────────────────

  /**
   * Step 7 — click Confirm, wait for POST /booking/:locationId/:bayId and the redirect to
   * /book-slot/success?bookingId=…&returnTo=/book-now.
   */
  async confirmBooking(modal: Locator, { read = 0 }: { read?: number } = {}): Promise<string> {
    const confirm = this.confirmButton(modal);
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeVisible();
    await expect(confirm).toBeEnabled();
    const responsePromise = this.page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().startsWith(env.apiURL) && /\/booking\/[0-9a-f-]{36}\/[0-9a-f-]{36}/i.test(r.url()),
      { timeout: 60_000 },
    );
    await this.guidedClick(confirm, { read });
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    expect(response.status(), `create booking HTTP status (body: ${JSON.stringify(body).slice(0, 300)})`).toBeLessThan(400);
    expect(body?.success, `create booking success flag: ${JSON.stringify(body).slice(0, 300)}`).toBe(true);
    expect(body?.bookingId, "bookingId in create response").toBeTruthy();
    await this.page.waitForURL(/\/book-slot\/success\?/, { timeout: 30_000 });
    const url = new URL(this.page.url());
    expect(url.searchParams.get("bookingId")).toBe(String(body.bookingId));
    return String(body.bookingId);
  }

  async verifyCheckout(created: CreatedBooking) {
    const page = this.page;
    // Persistence: the screen itself fetches GET /booking/:id from the backend. The recorder keeps that response, so
    // this returns at once when the screen loaded it before we got here (it used to wait 30s for a request already gone).
    const fetched = await expect
      .poll(() => this.api.bookingById.has(created.bookingId), { timeout: 30_000 })
      .toBe(true)
      .then(() => this.api.bookingById.get(created.bookingId)!, () => null);

    await expect(page.getByRole("heading", { name: "Booking Confirmed" })).toBeVisible();
    await expect(page.getByText("Booking confirmation email sent to")).toBeVisible();
    await expect(page.getByText(checkoutDateLabel(created.date, todayIn(this.tz)), { exact: true })).toBeVisible();
    await expect(page.getByText(`${pad12(created.startTime)} - ${pad12(created.endTime)}`)).toBeVisible();
    await expect(page.getByText(created.locationName, { exact: true })).toBeVisible();
    await expect(page.getByText(created.bayName, { exact: true })).toBeVisible();
    const persons = created.groupSize > 1 ? `${created.groupSize} Persons` : "1 Player";
    await expect(page.getByText(persons, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add to Google Calendar" })).toBeVisible();
    const view = page.getByRole("button", { name: "View My Booking" });
    await expect(view).toBeVisible();
    await expect(view).toBeEnabled();

    if (fetched) {
      expect(fetched.status).toBeLessThan(400);
      const booking = unwrap<any>(fetched.body);
      expect(booking?.id ?? created.bookingId).toBe(created.bookingId);
      if (booking?.numberOfPersons != null) expect(Number(booking.numberOfPersons)).toBe(created.groupSize);
      if (booking?.bayId) expect(booking.bayId).toBe(created.bayId);
      if (booking?.isCancelled != null) expect(booking.isCancelled).toBeFalsy();
      return booking;
    }
    return null;
  }

  /**
   * Step 9 — "View My Booking" on the Booking Confirmed screen returns to the bay calendar. The calendar's date
   * state is not carried over, so we move to the booking date with the real arrows, verify the booking there
   * (API list + outlined cells) and, unless `highlight` is false, keep it on screen for TEETIME_SHOW_MS.
   * Used after create, reschedule, group-size update, extend and quick shift.
   */
  async viewMyBooking(b: CreatedBooking, { highlight = true }: { highlight?: boolean } = {}) {
    await this.guidedClick(this.page.getByRole("button", { name: "View My Booking" }));
    await this.waitForBookingUi();
    await this.goToDate(b.date);
    await this.verifyBookingOnCalendar(b);
    if (highlight) await this.highlightBooking(b);
  }

  /** The booking's ⋮ (more) button on the calendar -> the "Manage your booking" modal. */
  async openManageMenu(b: { bayId: string; startIdx: number }): Promise<Locator> {
    await this.guidedClick(this.cell(b.bayId, b.startIdx).getByRole("button").first());
    const menu = this.dialog("Manage your booking");
    await expect(menu).toBeVisible();
    return menu;
  }

  /**
   * Slots startIdx..endIdx of a bay no longer belong to the user's booking (moved, or cancelled). Slots inside
   * `keep` (the booking's new range, when it overlaps the old one) are skipped.
   */
  async expectNotOwnBooking(bayId: string, startIdx: number, endIdx: number, keep?: { startIdx: number; endIdx: number }) {
    await this.cell(bayId, startIdx).scrollIntoViewIfNeeded();
    for (let s = startIdx; s <= endIdx; s++) {
      if (keep && s >= keep.startIdx && s <= keep.endIdx) continue;
      await expect(this.cell(bayId, s)).not.toHaveClass(OWN_BOOKING_STYLE);
    }
  }

  async verifyBookingOnCalendar(created: CreatedBooking) {
    // Backend list loaded by the calendar contains the booking.
    await expect
      .poll(() => (this.api.lastBookingList ?? []).some((b: any) => b.id === created.bookingId), {
        message: `booking ${created.bookingId} in /booking/get-every`,
        timeout: 30_000,
      })
      .toBe(true);
    const fromApi = (this.api.lastBookingList ?? []).find((b: any) => b.id === created.bookingId);
    expect(fromApi.bayId).toBe(created.bayId);
    if (fromApi.numberOfPersons != null) expect(Number(fromApi.numberOfPersons)).toBe(created.groupSize);

    // UI: the user's own booking covers the whole range: no slot of it is free, and each shows the own-booking outline.
    for (let s = created.startIdx; s <= created.endIdx; s++) {
      await expect(this.cell(created.bayId, s)).toHaveClass(OWN_BOOKING_STYLE);
      await expect.poll(() => this.slotIsFree(created.bayId, s), { message: `${fromMinutes(s * 15)} is booked` }).toBe(false);
    }
  }

}

