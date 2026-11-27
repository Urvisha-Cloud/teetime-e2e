// Creating a booking: Booking Details -> Confirm -> Booking Confirmed, a free slot found and booked, End Time.
import type { Locator, TestInfo } from "@playwright/test";
import { BookingApp, type CreatedBooking, type SelectedBooking } from "../../support/booking-app";
import { env } from "../../support/env";
import { fromMinutes, isoDate } from "../../support/time";
import { expect, testUser } from "../fixtures";
import { orBlocked } from "./suite";
import { selectRequestedSlot } from "./slots";
import { ensureEmptyWallet, expectPaidByCard, outsideCreditHours } from "./payment";
import { showBookingEmail } from "./email";

type StripeCard = Parameters<BookingApp["enterCard"]>[1];

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

/**
 * Booking Details is ready (group size picked, wallet / gift card / member credit applied by the test): scroll to the
 * waiver -> tick it -> the card pays what is left, if anything -> Confirm -> Booking Confirmed -> the booking email.
 * `track` gets the booking as soon as it exists, so the suite cancels it afterwards even when the test stops early.
 */
export async function confirmNewBooking(
  app: BookingApp,
  testInfo: TestInfo,
  modal: Locator,
  sel: SelectedBooking,
  { groupSize = 1, track }: { groupSize?: number; track?: (b: CreatedBooking) => void } = {},
): Promise<CreatedBooking> {
  await app.scrollThrough(modal);
  await app.acceptWaiver(modal);
  if ((await app.amountToPay(modal)) > 0) await orBlocked(testInfo, () => app.preparePayment(modal));
  const bookingId = await app.confirmBooking(modal, { read: Math.min(1500, app.readMs) });
  testInfo.annotations.push({ type: "bookingId", description: bookingId });
  const booking = { ...sel, bookingId, groupSize };
  track?.(booking);
  await expectConfirmed(app, booking, { pause: false });
  await showBookingEmail(app, testInfo, booking, "confirmed");
  return booking;
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
    cardOnly = false,
  }: {
    groupSize?: number;
    attempts?: number;
    /** never book these bays (e.g. all but Impact Vision) */
    excludeBayIds?: string[];
    /** The card pays all of it: empty wallet (a popup asks to empty it), outside member credit hours, checked afterwards. */
    cardOnly?: boolean;
  } = {},
): Promise<CreatedBooking> {
  if (cardOnly) {
    await ensureEmptyWallet(app, testInfo);
    options = { ...options, ...(await outsideCreditHours(app)) };
  }
  let lastError: unknown;
  let booked: CreatedBooking | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Retries reload the page, so the calendar shows the latest availability
    const sel = await selectRequestedSlot(app, testInfo, excludeBayIds, attempt === 1 ? options : { ...options, reuseOpenPage: false });
    const before = new Set(await app.myActiveBookingIds());
    try {
      booked = await bookSlot(app, testInfo, sel, { groupSize });
      break;
    } catch (e) {
      if (testInfo.expectedStatus === "skipped") throw e; // a deliberate skip (e.g. no way to pay), not a failed slot
      lastError = e;
      // Another slot cannot help: the test user's Stripe customer takes no more cards
      if (/maximum number of payment methods/i.test(e instanceof Error ? e.message : String(e))) {
        throw new Error(
          `The card was refused, not the slot: the Stripe customer of ${testUser.email ?? env.testEmail} already has the maximum number of ` +
            "cards. Remove old cards from that customer in the Stripe TEST dashboard, or rename .auth/e2e-user.json so the next run signs up a new test user.",
        );
      }
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
  if (booked) {
    if (cardOnly) await expectPaidByCard(app, testInfo, booked); // a wrong payment is a failure, not a reason to retry
    return booked;
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

// ───────────────────────────── Booking Details: End Time ─────────────────────────────

/**
 * The End Time dropdown's option for `endTime` (Booking Details). Near midnight the list runs into the next day, so
 * the same time can be listed twice (e.g. "2:00 AM" today and tomorrow): take the first one that can be picked —
 * the nearest end after the start.
 */
export function endTimeOption(app: BookingApp, endTime: string): Locator {
  return app.page.getByRole("option", { name: endTime, exact: true }).and(app.page.locator(":not([data-disabled])")).first();
}

/** Booking Details: End Time -> `hours` after the start (no second selection). Returns the longer selection. */
export async function setBookingHours(app: BookingApp, modal: Locator, sel: SelectedBooking, hours: number): Promise<SelectedBooking> {
  const endIdx = sel.startIdx + hours * 4 - 1;
  const endTime = fromMinutes((endIdx + 1) * 15);
  await app.guidedClick(modal.getByRole("combobox").nth(2)); // End Time
  await app.guidedClick(endTimeOption(app, endTime), { read: app.readMs });
  await expect(modal, "Booking Details shows the new time").toContainText(`${sel.startTime} - ${endTime}`);
  return { ...sel, endIdx, endTime };
}
