import type { Locator, TestInfo } from "@playwright/test";
import type { BookingApp, CreatedBooking, SelectedBooking } from "../../support/booking-app";
import { env } from "../../support/env";
import { type LocalDate, compareDates, headerLabel, isoDate, pad12, todayIn } from "../../support/time";
import {
  bookingSuite,
  cancelInUi,
  clickAndExpectPatch,
  confirmNewBooking,
  expectBookingGone,
  expectRefundShown,
  minutesUntilStart,
  refundPercentFor,
  requireBookingCreation,
  selectRequestedSlot,
  showBookingEmail,
} from "../helper";
import { expect, test, testUser } from "../fixtures";
import { creditLine, discountLine, giftTotal, paidWith, refundSplit, round2, sessionPrice } from "../money";

/**
 * Test cases 41–46 — Core membership: join, a booking paid with member credit (checked on the Membership tab, then
 * cancelled), then a booking with the member discount (no credit), cancelled too. Runs as the run's logged-in test
 * user (it stays a Core member afterwards).
 *
 * How the app prices a member's booking (Booking Details): member credit pays every 15 min inside the plan's credit
 * hours (Core: every day 1 AM – 3 PM) while there is credit, for at most 2 hours a day ("Membership credit" line);
 * whatever the credit does not pay gets the member discount (Core: 10%, "Member discount (10% off)" line). There is
 * no switch to leave the credit out, so the discount-only booking is made after 3 PM, when credit hours are over.
 *
 *  TC41  sidebar "Membership" -> "Join Core" -> Join Core popup (saved card) -> "Pay $99" -> POST /membership/subscribe
 *         -> "Welcome to Core!" -> the page shows the active Core card (credit $x / $150); GET /membership/me: active.
 *         Already an active member -> nothing to buy, the membership is checked as it is.
 *  TC42  booking 1: the first day with credit hours left (days where the user's other bookings already used the
 *         2 credit hours are skipped: GET /membership/me creditUsage) and a bay free 1 PM – 3 PM (1 hr) -> Booking Details: "Membership
 *         credit" pays it -> Confirm -> Booking Confirmed -> YopMail: the booking email -> saved
 *         paymentBreakdown.membershipCreditAmount = the credit shown -> "View My Booking": back to the calendar
 *  TC43  sidebar "Membership": the Core card shows the balance − the credit used and "$x used this month"; the
 *         newest credit history entry is "Used on a booking −$credit" -> "Book Your Bay": back to the calendar, moved
 *         to booking 1's day (the booking is shown there)
 *  TC44  cancel booking 1 (normal cancel flow) -> "Booking cancelled" -> its slots free; the credit balance goes up by
 *         the refund policy's share of the credit it used (90% more than 4 h before the start, 50% 1–4 h, none within
 *         1 h; e.g. $10 credit cancelled a day ahead -> $9 back)
 *  TC45  booking 2: the first free time after 3 PM (1 hr) -> Booking Details: NO "Membership credit", "Member
 *         discount (10% off)" = 10% of the session price, "You pay" at most price − discount (wallet / card pay it)
 *         -> Confirm -> Booking Confirmed -> YopMail -> saved: no membership credit, paid = discounted price -> calendar
 *  TC46  cancel booking 2 -> the cancel popup's refund (policy tier of what was paid) -> applied -> slots free
 *
 * Times are never fixed: the first day (from today, up to 7 days ahead) with a free bay in the window is used.
 * The Join Core payment uses the card saved on the account (TEETIME_PAYMENT_MODE does not apply to it).
 */

/** Booking 1 lies in 1 PM – 3 PM (Core's credit hours end at 3 PM). */
const CREDIT_WINDOW = { from: 13 * 60, to: 15 * 60 };
/** Booking 2 starts at 3 PM or later (outside credit hours: only the member discount), ending by midnight. */
const DISCOUNT_WINDOW = { from: 15 * 60, to: 24 * 60 };
/** Both bookings are 1 hr. */
const BOOKING_MINUTES = 60;
/** The app's daily credit limit: 8 × 15 min = 2 hours. */
const DAILY_CREDIT_SLOTS = 8;
/** 6 slots -> "1.5 hr". */
const formatHours = (slots: number) => `${slots / 4} hr`;

const money = (s: string) => Number(s.replace(/,/g, ""));

/** The member credit a cancellation of `booking` gives back (refundSplit: the fee is taken from the credit last). */
const creditRefund = (booking: any, percent: number) => refundSplit(paidWith(booking), percent).credit;

/**
 * Booking `b`'s card on the My Booking page. Every card has one "Modify" button, so a card is the largest block around
 * one Modify button (found by that, not by its styling), matched by bay, start time and length — and by the date too
 * when another of the user's bookings has the same. Exactly one card must be left, so that no other booking is changed.
 */
async function findMyBookingCard(app: BookingApp, b: CreatedBooking, what: string): Promise<Locator> {
  let card = app.page
    .getByRole("button", { name: "Modify", exact: true })
    .locator("xpath=ancestor::div[count(.//button[normalize-space(.)='Modify'])=1][last()]")
    .filter({ visible: true })
    .filter({ hasText: new RegExp(`${b.bayName} – `) })
    .filter({ hasText: pad12(b.startTime) })
    .filter({ hasText: `${BOOKING_MINUTES} min` });
  await expect(card.first(), `${what}'s card (${b.bayName}, ${pad12(b.startTime)})`).toBeVisible({ timeout: 20_000 });
  if ((await card.count()) > 1) {
    const month = headerLabel(b.date).split(" ")[0];
    const days = compareDates(b.date, todayIn(app.tz)) / 86_400_000;
    const near = days === 0 ? "|Today" : days === 1 ? "|Tomorrow" : "";
    card = card.filter({ hasText: new RegExp(`${month}[a-z]* 0?${b.date.day}(?!\\d)|(?<!\\d)0?${b.date.day}(st|nd|rd|th)? ${month}${near}`) });
  }
  await expect(card, `exactly one card for ${what}`).toHaveCount(1);
  return card;
}

/**
 * My Booking -> `b`'s card -> Modify -> Cancel booking -> the refund shown (policy tier of what was paid) -> Confirm
 * Cancellation -> saved as cancelled with that refund, the card gone, the member credit unchanged, the cancel email,
 * and its slots free on the calendar.
 */
async function cancelOnMyBookingPage(app: BookingApp, testInfo: TestInfo, b: CreatedBooking, what: string, markCancelled: () => void) {
  const page = app.page;
  const before = await creditBalance(app);
  await app.guidedClick(page.getByText("My Booking", { exact: true }).first(), { read: app.readMs });
  await expect(page, "the My Booking page").toHaveURL(/\/my-bookings$/);
  const card = await findMyBookingCard(app, b, what);
  await app.guidedClick(card.getByRole("button", { name: "Modify", exact: true }), { read: app.readMs });
  const menu = app.dialog("Manage your booking");
  await expect(menu).toBeVisible();
  await app.guidedClick(menu.getByRole("button", { name: "Cancel booking", exact: true }), { read: app.readMs });
  const cancel = app.dialog("Confirm Cancellation");
  await expect(cancel.getByRole("heading", { name: "Cancel Booking" }), "the cancel popup").toBeVisible();

  const refund = await expectRefundShown(app, testInfo, cancel, b); // policy tier of what was paid
  await clickAndExpectPatch(app, testInfo, cancel.getByRole("button", { name: "Confirm Cancellation" }), "cancel", b.bookingId);
  markCancelled();
  await expect(cancel, "the cancel popup closes").toBeHidden({ timeout: 15_000 });
  await expect(card, "the card is gone from My Booking").toHaveCount(0, { timeout: 20_000 });
  const after = await app.fetchBooking(b.bookingId);
  expect(after?.isCancelled, "saved as cancelled").toBe(true);
  expect(Number(after?.metadata?.refundAmount ?? NaN), `refund applied: ${refund.percent}% of ${refund.paid.toFixed(2)}`).toBeCloseTo(refund.amount, 2);
  expect(Number(after?.metadata?.cancellationFee ?? NaN), "cancellation fee = paid − refund").toBeCloseTo(round2(refund.paid - refund.amount), 2);
  expect(await creditBalance(app), "credit neither deducted nor given back").toBeCloseTo(before, 2);
  await showBookingEmail(app, testInfo, b, "cancelled");
  await toCalendar(app);
  await expectBookingGone(app, b);
}

/**
 * The Membership page's Refresh button (top right): it reloads the page, so the app reads GET /membership/me and the
 * credit history anew instead of showing the answer it keeps for 30 s (staleTime).
 */
async function refreshMembership(app: BookingApp) {
  await app.guidedClick(app.page.getByRole("button", { name: "Refresh", exact: true }), { read: app.readMs });
  await expect(app.page, "the Membership page").toHaveURL(/\/membership$/);
  await expect(app.page.getByRole("heading", { name: "Membership", level: 1 }), "the Membership page after Refresh").toBeVisible({ timeout: 30_000 });
}

/** The sidebar's "Book Your Bay" -> the calendar, inside the app (no page reload). Nothing to do when it is shown. */
async function toCalendar(app: BookingApp) {
  if (new URL(app.page.url()).pathname !== "/book-now") {
    await app.guidedClick(app.page.getByText("Book Your Bay", { exact: true }).first(), { read: app.readMs });
    await expect(app.page).toHaveURL(/\/book-now$/);
  }
  await app.waitForBookingUi();
}

/** The sidebar's "Membership" -> the Membership page, inside the app (no page reload). */
async function toMembership(app: BookingApp) {
  await app.guidedClick(app.page.getByText("Membership", { exact: true }).first(), { read: app.readMs });
  await expect(app.page, "the Membership page").toHaveURL(/\/membership$/);
  await expect(app.page.getByText("Monthly credit, member discount and more")).toBeVisible();
}

test.describe("Core membership: credit booking and discount booking @membership @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let member: any = null; // GET /membership/me once active (TC41)
  let booking1: CreatedBooking | undefined; // paid with member credit (TC42)
  let booking2: CreatedBooking | undefined; // member discount, no credit (TC45)
  let balanceBefore = 0; // credit balance before booking 1
  let creditUsed = 0; // member credit booking 1 used
  let cancelled1 = false;

  // Booking 1 is not tracked by bookingSuite (it tracks one booking: booking 2); cancel it here if a test stopped early
  test.afterAll(async () => {
    if (app && booking1 && !cancelled1 && env.cleanup) {
      const res = await app.cancelBooking(booking1.bookingId);
      console.log(`[teetime-e2e] cleanup: cancel ${booking1.bookingId}: HTTP ${res.status}`);
    }
  });

  test("TC41: Membership -> Join Core -> Pay -> active Core member", async ({}, testInfo) => {
    requireBookingCreation();
    await app.openIfNeeded();
    const page = app.page;
    await toMembership(app);

    member = await app.membership();
    if (isElite(member)) {
      member = null; // TC42–46 are skipped too: they check a Core member
      test.skip(true, "Already an Elite member (an earlier run upgraded it): the Core cases need an account without membership, or on Core");
    }
    if (member?.status === "active") {
      const note = `${testUser.email ?? "the test user"} is already an active ${member.plan?.name} member (credit $${Number(member.creditBalance).toFixed(2)}): nothing to buy`;
      testInfo.annotations.push({ type: "membership", description: note });
      console.log(`[teetime-e2e] membership: ${note}`);
    } else {
      // "Join Core" -> the Join Core popup with the saved card -> "Pay $99"
      await app.guidedClick(page.getByRole("button", { name: "Join Core", exact: true }), { read: app.readMs });
      const join = app.dialog(/Join Core/);
      await expect(join, "the Join Core popup").toBeVisible();
      await expect(join).toContainText("Payment details");
      const savedCard = join.getByText(/\*{4}\s*\d{4}/).first();
      if (!(await savedCard.isVisible({ timeout: 5_000 }).catch(() => false))) {
        const why = "No saved card on the account for the membership payment: add one in Card Details first";
        testInfo.annotations.push({ type: "blocked", description: why });
        test.skip(true, why);
      }
      const pay = join.getByRole("button", { name: /^Pay \$/ });
      const price = (await pay.innerText()).trim();
      await app.readPause();
      const subscribe = page.waitForResponse((r) => r.request().method() === "POST" && /\/membership\/subscribe(\?|$)/.test(r.url()), { timeout: 60_000 });
      await app.guidedClick(pay, { read: app.readMs });
      const res = await subscribe;
      const body = await res.json().catch(() => ({}));
      testInfo.annotations.push({ type: "membership-subscribe", description: `${price}: HTTP ${res.status()} ${JSON.stringify(body).slice(0, 200)}` });
      expect(res.ok(), `POST /membership/subscribe: HTTP ${res.status()} ${JSON.stringify(body).slice(0, 200)}`).toBe(true);
      await expect(page.getByText(/Welcome to Core!/).first(), "the success message").toBeVisible({ timeout: 30_000 });
      await expect(join, "the Join Core popup closes").toBeHidden({ timeout: 15_000 });
      await expect.poll(async () => (member = await app.membership())?.status, { message: "GET /membership/me: active", timeout: 30_000 }).toBe("active");
    }

    // Active Core member: the API and the Membership page agree
    expect(member.plan?.tier ?? member.plan?.code, "the plan").toBe("core");
    const credit = Number(member.creditBalance);
    const monthly = Number(member.plan.monthlyCredit);
    testInfo.annotations.push({
      type: "membership",
      description: `active ${member.plan.name}: credit $${credit.toFixed(2)} / $${monthly}, ${member.plan.discountPercent}% off, renews ${member.currentPeriodEnd ?? "?"}`,
    });
    await expect(page.getByText("Active", { exact: true }).first(), 'the "Active" badge').toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`$${credit.toFixed(2)}`).first(), "the credit balance on the card").toBeVisible();
    await expect(page.getByText(`/ $${monthly.toFixed(0)}`).first(), "the monthly credit").toBeVisible();
    await expect(page.getByText("Become a member →"), "the sidebar no longer offers membership").toBeHidden();
    await app.readPause();
  });

  test("TC42: booking 1 at 1–3 PM paid with member credit -> Booking Confirmed -> booking email -> back to the calendar", async ({}, testInfo) => {
    test.skip(member?.status !== "active", "TC41: not an active member");
    const m = await app.membership();
    balanceBefore = Number(m?.creditBalance ?? 0);
    test.skip(balanceBefore <= 0, `No member credit left this month ($${balanceBefore.toFixed(2)}): booking 1 cannot use credit`);

    // Credit hours the test user's other bookings already used, per day (the server's count; keys as YYYY-MM-DD)
    const usedByDay: Record<string, number> = {};
    for (const [day, slots] of Object.entries<any>(m?.creditUsage?.slotsByDate ?? {})) usedByDay[day.slice(0, 10)] = Number(slots) || 0;
    testInfo.annotations.push({ type: "credit-usage", description: `credit slots used per day: ${JSON.stringify(usedByDay).slice(0, 200)}` });
    // A day whose 2 credit hours are (partly) taken cannot pay this booking with credit in full: try the next day
    const needed = BOOKING_MINUTES / 15;
    const skipDay = (d: LocalDate) => {
      const used = usedByDay[isoDate(d)] ?? 0;
      return used + needed > DAILY_CREDIT_SLOTS ? `member credit hours already used: ${formatHours(used)} of 2 hr` : null;
    };

    // Membership -> calendar with the sidebar (no reload), then the first day with credit hours left and a bay free
    // inside 1–3 PM on the calendar as it is; another free slot is searched when one is taken
    await toCalendar(app);
    const sel = await selectRequestedSlot(app, testInfo, [], { bookingMinutes: BOOKING_MINUTES, rescheduleRoom: false, dayWindow: CREDIT_WINDOW, reuseOpenPage: true, skipDay });
    const modal = await app.openBookingModal(sel);
    await app.readPause();
    await app.selectGroupSize(modal, 1);
    await expect(modal, `the member credit in the price (credit slots used on ${isoDate(sel.date)}: ${usedByDay[isoDate(sel.date)] ?? 0} of ${DAILY_CREDIT_SLOTS})`).toContainText(
      /Membership credit/,
      { timeout: 15_000 },
    );
    const text = await modal.innerText();
    const price = sessionPrice(text);
    creditUsed = creditLine(text);
    const discount = discountLine(text);
    const toPay = await app.amountToPay(modal);
    testInfo.annotations.push({
      type: "price",
      description: `${isoDate(sel.date)} ${sel.startTime}–${sel.endTime} ${sel.bayName}: $${price.toFixed(2)}, credit −$${creditUsed.toFixed(2)}, member discount −$${discount.amount.toFixed(2)}, you pay $${toPay.toFixed(2)} (credit balance $${balanceBefore.toFixed(2)})`,
    });
    expect(creditUsed, "member credit used").toBeGreaterThan(0);
    expect(creditUsed, "no more credit than the balance").toBeLessThanOrEqual(balanceBefore + 0.01);
    // What the credit does not pay gets the member discount; "You pay" is at most the rest (the wallet, if it has
    // credit, pays before the card)
    const rest = Math.max(round2(price - creditUsed - discount.amount), 0);
    expect(toPay, `"You pay" at most $${price.toFixed(2)} − credit − discount = $${rest.toFixed(2)}`).toBeLessThanOrEqual(rest + 0.01);
    if (creditUsed >= price - 0.01) expect(discount.amount, "no member discount when the credit pays it all").toBe(0);

    booking1 = await confirmNewBooking(app, testInfo, modal, sel); // … Booking Confirmed -> YopMail: the booking email
    const p = (await app.fetchBooking(booking1.bookingId))?.paymentBreakdown ?? {};
    testInfo.annotations.push({ type: "paymentBreakdown", description: JSON.stringify(p).slice(0, 300) });
    expect(Number(p.membershipCreditAmount || 0), "saved membership credit").toBeCloseTo(creditUsed, 2);

    // Back to the calendar: "View My Booking" -> the booking on the calendar
    await app.viewMyBooking(booking1);
  });

  test("TC43: Membership tab -> the credit booking 1 used: balance, used this month, credit history -> back to the calendar", async ({}, testInfo) => {
    test.skip(!booking1, "TC42 did not create booking 1");
    const page = app.page;
    const expected = round2(balanceBefore - creditUsed);
    // The API first (the page shows what it returns)
    await expect
      .poll(async () => round2(Number((await app.membership())?.creditBalance ?? NaN)), { message: `credit balance = $${balanceBefore.toFixed(2)} − $${creditUsed.toFixed(2)}`, timeout: 20_000 })
      .toBeCloseTo(expected, 2);
    const monthly = Number(member.plan.monthlyCredit);
    const usedThisMonth = round2(monthly - Math.min(Math.max(expected, 0), monthly));

    // Sidebar "Membership": the Core card shows the new balance and what was used; the credit history the booking
    await toMembership(app);
    const balanceText = page.getByText(`$${expected.toFixed(2)}`).first();
    const shown = await balanceText.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
    if (!shown) {
      // The page shows the app's earlier answer: it keeps GET /membership/me for 30 s and read it less than 30 s ago
      // (an older one would have been read again just now). The page's own Refresh button reloads it, which reads
      // it anew at once (instead of waiting out the 30 s)
      console.log("[teetime-e2e] membership: the page shows the app's earlier credit (kept 30 s); pressing Refresh");
      await refreshMembership(app);
    }
    await expect(balanceText, `the credit balance $${expected.toFixed(2)} on the Core card`).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`$${usedThisMonth.toFixed(2)} used this month`).first(), "used this month").toBeVisible();
    // Credit history, newest first: "Used on a booking  −$x"
    await expect(page.getByText("Credit history")).toBeVisible();
    // The app re-reads the history after the page opens and redraws the list: read it until it shows this booking
    const newestEntry = async () => {
      const history = await page.locator("main").or(page.locator("body")).first().innerText();
      const at = history.indexOf("Credit history");
      return at < 0 ? "" : history.slice(at, at + 160);
    };
    const thisBooking = new RegExp(`Used on a booking[\\s\\S]{0,60}?[−–-]\\s?\\$${creditUsed.toFixed(2).replace(".", "\\.")}`);
    await expect.poll(newestEntry, { message: "the newest credit history entry: this booking", timeout: 15_000 }).toMatch(thisBooking);
    testInfo.annotations.push({ type: "credit-history", description: (await newestEntry()).replace(/\s+/g, " ") });
    // Show it on screen; a redraw in between replaces the row, so the scroll is simply tried again
    await expect(async () => {
      await page.getByText("Used on a booking").first().scrollIntoViewIfNeeded({ timeout: 2_000 });
    }).toPass({ timeout: 10_000 });
    await app.readPause();

    // Back to the calendar: "Book Your Bay" opens it on today, so move to booking 1's day — the booking is shown there
    await app.guidedClick(page.getByText("Book Your Bay", { exact: true }).first(), { read: app.readMs });
    await expect(page).toHaveURL(/\/book-now$/);
    await app.waitForBookingUi();
    await app.goToDate(booking1!.date);
    await app.verifyBookingOnCalendar(booking1!);
    await app.highlightBooking(booking1!);
  });

  test("TC44: back on the calendar: cancel booking 1 -> Booking cancelled -> slots free -> the policy's share of the member credit comes back", async ({}, testInfo) => {
    test.skip(!booking1, "TC42 did not create booking 1");
    const balanceBeforeCancel = Number((await app.membership())?.creditBalance ?? 0);
    // What comes back follows the refund policy for the time left before the start (90% / 50% / none)
    const minutes = minutesUntilStart(app, booking1!);
    const percent = refundPercentFor(minutes);
    const back = creditRefund(await app.fetchBooking(booking1!.bookingId), percent);
    testInfo.annotations.push({
      type: "credit-refund",
      description: `${minutes} min before the start: ${percent}% -> $${back.toFixed(2)} of the $${creditUsed.toFixed(2)} credit back`,
    });

    // The calendar must show booking 1's day (its ⋮ is opened there); TC43 left it there — make sure when run alone
    await app.goToDate(booking1!.date);
    await cancelInUi(app, testInfo, booking1!); // ⋮ -> Cancel booking -> Confirm Cancellation -> "Booking cancelled"
    cancelled1 = true;
    await expectBookingGone(app, booking1!);
    // The credit balance goes up by the policy's share of the credit booking 1 used
    await expect
      .poll(async () => round2(Number((await app.membership())?.creditBalance ?? NaN)), {
        message: `credit balance = $${balanceBeforeCancel.toFixed(2)} + $${back.toFixed(2)} (${percent}% of the $${creditUsed.toFixed(2)} credit)`,
        timeout: 20_000,
      })
      .toBeCloseTo(round2(balanceBeforeCancel + back), 2);
    testInfo.annotations.push({ type: "credit", description: `$${balanceBeforeCancel.toFixed(2)} + $${back.toFixed(2)} given back (${percent}%)` });
  });

  test("TC45: booking 2 after 3 PM (outside credit hours): 10% member discount, no credit -> Booking Confirmed", async ({}, testInfo) => {
    test.skip(member?.status !== "active", "TC41: not an active member");
    const plan = member.plan;
    // The first free time after 3 PM: credit hours are over, only the member discount applies
    // The calendar as it is (TC44 left it open; no reload)
    await toCalendar(app);
    const sel = await selectRequestedSlot(app, testInfo, [], { bookingMinutes: BOOKING_MINUTES, rescheduleRoom: false, dayWindow: DISCOUNT_WINDOW, reuseOpenPage: true });
    const modal = await app.openBookingModal(sel);
    await app.readPause();
    await app.selectGroupSize(modal, 1);
    await expect(modal, "the member discount in the price").toContainText(/Member discount/, { timeout: 15_000 });
    const text = await modal.innerText();
    const price = sessionPrice(text);
    const discount = discountLine(text);
    const toPay = await app.amountToPay(modal);
    testInfo.annotations.push({
      type: "price",
      description: `${isoDate(sel.date)} ${sel.startTime}–${sel.endTime} ${sel.bayName}: $${price.toFixed(2)}, member discount ${discount.percent}% −$${discount.amount.toFixed(2)}, you pay $${toPay.toFixed(2)}`,
    });
    expect(creditLine(text), "no member credit after 3 PM").toBe(0);
    expect(discount.percent, "the discount is the plan's").toBe(Number(plan.discountPercent));
    expect(discount.amount, `member discount = ${plan.discountPercent}% of $${price.toFixed(2)}`).toBeCloseTo((price * Number(plan.discountPercent)) / 100, 1);
    const afterDiscount = round2(price - discount.amount);
    // The wallet (if it has credit) pays before the card: "You pay" is what is left of the discounted price
    expect(toPay, `"You pay" at most the discounted price $${afterDiscount.toFixed(2)}`).toBeLessThanOrEqual(afterDiscount + 0.01);

    booking2 = await confirmNewBooking(app, testInfo, modal, sel, { track: suite.track }); // … Booking Confirmed -> YopMail: the booking email

    // Saved: no membership credit; wallet + card paid the discounted price
    const p = (await app.fetchBooking(booking2.bookingId))?.paymentBreakdown ?? {};
    testInfo.annotations.push({ type: "paymentBreakdown", description: JSON.stringify(p).slice(0, 300) });
    expect(Number(p.membershipCreditAmount || 0), "no membership credit saved").toBe(0);
    expect(round2(Number(p.cardAmount || 0) + Number(p.walletAmount || 0) + giftTotal(p)), "paid = the discounted price").toBeCloseTo(afterDiscount, 1);
    await app.viewMyBooking(booking2); // back to the calendar
  });

  test("TC46: cancel booking 2 -> refund shown and applied -> slots free", async ({}, testInfo) => {
    test.skip(!booking2, "TC45 did not create booking 2");
    await app.goToDate(booking2!.date); // the calendar on booking 2's day (its ⋮ is opened there)
    await cancelInUi(app, testInfo, booking2!, { checkRefund: true }); // the policy tier of what was paid (wallet / card)
    suite.markCancelled();
    await expectBookingGone(app, booking2!);
  });
});

// ───────────────────────────── Elite upgrade ─────────────────────────────

/**
 * Test cases 47–52 — upgrade to Elite, a booking paid with Elite credit (cancelled), then one with the 15% Elite
 * discount and no credit (cancelled from My Booking). A group of its own after TC41–46: it runs even when one of those
 * failed, and needs only an active Core (or already Elite) member.
 *
 * The upgrade cannot be undone by the test: the app switches back to Core only at the next renewal. On an account that
 * is already Elite, TC47 is skipped (there is no "Upgrade to Elite" any more) and TC48 checks the Elite membership.
 *
 *  TC47  Membership -> "Upgrade to Elite" -> the popup: title, $299/month, +$400 credit and the seven Elite benefits
 *  TC48  "Upgrade now" -> POST /membership/change-plan (charged to the card on file; no card form) -> "You're now on
 *         Elite" -> GET /membership/me: active Elite, $550 / 15%, credit up by $400 -> the page and the sidebar say Elite
 *  TC49  booking 1: the first free hour inside the plan's credit hours (1 AM – 3 PM), on a day with credit hours left
 *         -> 1, 2 and 3 players cost the same -> 5 players (the whole bay): the credit pays everything, also the app's
 *         $5/hr for 4–5 players while the plan's freePersons is below 5 -> "You pay" $0.00 -> Booking Confirmed
 *         -> saved: the credit, 5 players, nothing from card / wallet / gift card; balance down by the credit used
 *  TC50  cancel booking 1 on the calendar -> refund policy's share of the credit is back in the balance
 *  TC51  booking 2: the first free hour after credit hours, 2 players -> no credit, "Member discount (15% off)" = 15% of
 *         the session price, "You pay" = price − discount − wallet -> Booking Confirmed -> saved amounts; credit unchanged
 *  TC52  My Booking -> booking 2's card -> Modify -> Cancel booking -> refund shown and applied -> saved as cancelled, card
 *         gone, slots free; credit unchanged
 */
const ELITE_FEATURES = [
  "$550 golf credit every month",
  "Use it at any TeeTime location",
  "15% off all other bookings",
  "Credit hours: Every day, 1 AM – 3 PM",
  "Credit covers up to 2 hours a day",
  "Book 15 days ahead",
  "Up to 3 players at no extra cost",
];
/** Players in the Elite credit booking (TC49): the whole bay. */
const ELITE_PLAYERS = 5;
/** The app's charge for a group bigger than the plan's free players ("+$5.00/hr" for 4–5 players). */
const EXTRA_PERSONS_PER_HOUR = 5;
const isElite = (m: any) => m?.status === "active" && (m.plan?.tier ?? m.plan?.code) === "elite";
const clock = (hhmm: string) => Number(hhmm.split(":")[0]) * 60 + Number(hhmm.split(":")[1]);
/** The credit hours of the plan, in minutes of the day ("01:00"–"15:00" -> 60–900). */
const creditHours = (plan: any) => ({ from: clock(plan.creditWindows[0].startTime), to: clock(plan.creditWindows[0].endTime) });
const creditBalance = async (app: BookingApp) => round2(Number((await app.membership())?.creditBalance ?? NaN));

test.describe("Elite membership: upgrade, credit booking and discount booking @membership @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let elite: any = null; // GET /membership/me once Elite (TC48)
  let upgradeOpen = false; // TC47 left the Upgrade to Elite popup open
  let booking1: CreatedBooking | undefined; // paid with Elite credit (TC49)
  let booking2: CreatedBooking | undefined; // 15% discount, no credit (TC51)
  let creditUsed = 0;
  let cancelled1 = false;

  // bookingSuite tracks one booking (booking 2); booking 1 is cancelled here if a test stopped early
  test.afterAll(async () => {
    if (app && booking1 && !cancelled1 && env.cleanup) {
      const res = await app.cancelBooking(booking1.bookingId);
      console.log(`[teetime-e2e] cleanup: cancel ${booking1.bookingId}: HTTP ${res.status}`);
    }
  });

  test("TC47: Membership -> Upgrade to Elite -> the popup shows the price, the credit and every Elite benefit", async ({}, testInfo) => {
    requireBookingCreation();
    await app.openIfNeeded();
    const m = await app.membership();
    test.skip(m?.status !== "active", "Not an active member: there is no plan to upgrade (TC41 joins Core)");
    test.skip(isElite(m), "Already an Elite member: the app no longer offers \"Upgrade to Elite\"");
    await toMembership(app);
    await app.guidedClick(app.page.getByRole("button", { name: "Upgrade to Elite", exact: true }), { read: app.readMs });
    const popup = app.dialog(/Upgrade to Elite/);
    await expect(popup, "the Upgrade to Elite popup").toBeVisible();
    await expect(popup.getByText("Upgrade to Elite", { exact: true }), "title").toBeVisible();
    await expect(popup.getByText("$299/month", { exact: true }), "price").toBeVisible();
    await expect(popup.getByText("+$400 credit added straight away", { exact: true }), "credit added").toBeVisible();
    for (const feature of ELITE_FEATURES) await expect(popup.getByText(feature, { exact: true }), `benefit "${feature}"`).toBeVisible();
    await expect(popup.getByRole("button", { name: "Not now", exact: true })).toBeEnabled();
    await expect(popup.getByRole("button", { name: "Upgrade now", exact: true })).toBeEnabled();
    testInfo.annotations.push({ type: "upgrade", description: (await popup.innerText()).replace(/\s+/g, " ").slice(0, 400) });
    upgradeOpen = true;
    await app.readPause();
  });

  test("TC48: Upgrade now -> You're now on Elite -> active Elite member", async ({}, testInfo) => {
    requireBookingCreation();
    const page = app.page;
    const before = await app.membership();
    if (isElite(before)) {
      const note = `already an active Elite member (credit $${Number(before.creditBalance).toFixed(2)}): nothing to upgrade, only the membership is checked`;
      testInfo.annotations.push({ type: "membership", description: note });
      console.log(`[teetime-e2e] membership: ${note}`);
      await app.openIfNeeded();
      await toMembership(app);
      elite = before;
    } else {
      test.skip(!upgradeOpen, "TC47 did not open the Upgrade to Elite popup");
      const popup = app.dialog(/Upgrade to Elite/);
      const changed = page.waitForResponse((r) => r.request().method() === "POST" && /\/membership\/change-plan(\?|$)/.test(r.url()), { timeout: 60_000 });
      await app.guidedClick(popup.getByRole("button", { name: "Upgrade now", exact: true }), { read: app.readMs });
      const res = await changed;
      const body = await res.json().catch(() => ({}));
      const result = `HTTP ${res.status()} ${JSON.stringify(body).slice(0, 200)}`;
      testInfo.annotations.push({ type: "membership-change-plan", description: result });
      expect(res.ok(), `POST /membership/change-plan: ${result}`).toBe(true);
      await expect(page.getByText(/You're now on Elite/).first(), "the success message").toBeVisible({ timeout: 30_000 });
      await expect(popup, "the popup closes").toBeHidden({ timeout: 15_000 });
      // The plan changes when Stripe's payment reaches the backend
      await expect.poll(async () => isElite((elite = await app.membership())), { message: "GET /membership/me: active Elite", timeout: 60_000 }).toBe(true);
      const added = round2(Number(elite.plan.monthlyCredit) - Number(before.plan.monthlyCredit));
      expect(added, "credit added by the upgrade").toBe(400);
      await expect
        .poll(() => creditBalance(app), { message: `credit balance = $${Number(before.creditBalance).toFixed(2)} + $${added}`, timeout: 30_000 })
        .toBeCloseTo(round2(Number(before.creditBalance) + added), 2);
      elite = await app.membership();
    }

    // Elite in the API and on the Membership page (the open sidebar no longer shows the member card)
    expect(Number(elite.plan.price), "Elite price").toBe(299);
    expect(Number(elite.plan.monthlyCredit), "Elite monthly credit").toBe(550);
    expect(Number(elite.plan.discountPercent), "Elite discount").toBe(15);
    expect(Number(elite.plan.freePersons), "players at no extra cost").toBe(3);
    expect(Number(elite.plan.accessDays), "days ahead").toBe(15);
    expect(creditHours(elite.plan), "credit hours 1 AM – 3 PM").toEqual({ from: 60, to: 900 });
    await expect(page.getByText("$299/month", { exact: true }).first(), "the Elite card's price").toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Active", { exact: true }).first(), 'the "Active" badge').toBeVisible();
    await expect(page.getByText("/ $550", { exact: true }).first(), "the monthly credit").toBeVisible();
    await expect(page.getByText(`$${Number(elite.creditBalance).toFixed(2)}`, { exact: true }).first(), "the credit balance").toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Elite", { exact: true }).first(), "the plan name").toBeVisible();
    await app.readPause();
  });

  test("TC49: booking 1 with Elite credit: 5 players, nothing to pay -> Booking Confirmed -> credit deducted", async ({}, testInfo) => {
    test.skip(!elite, "TC48: not an Elite member");
    const m = await app.membership();
    const before = round2(Number(m.creditBalance));
    test.skip(before <= 0, "No Elite credit left this month");

    // Days whose 2 credit hours are (partly) used by other bookings are passed over (the server's count)
    const usedByDay: Record<string, number> = {};
    for (const [day, slots] of Object.entries<any>(m.creditUsage?.slotsByDate ?? {})) usedByDay[day.slice(0, 10)] = Number(slots) || 0;
    const skipDay = (d: LocalDate) => {
      const used = usedByDay[isoDate(d)] ?? 0;
      return used + BOOKING_MINUTES / 15 > DAILY_CREDIT_SLOTS ? `member credit hours already used: ${formatHours(used)} of 2 hr` : null;
    };
    await toCalendar(app);
    const sel = await selectRequestedSlot(app, testInfo, [], { bookingMinutes: BOOKING_MINUTES, rescheduleRoom: false, dayWindow: creditHours(elite.plan), reuseOpenPage: true, skipDay });
    const modal = await app.openBookingModal(sel);
    await app.readPause();

    // 1–3 players and the whole bay of 5: the same session price, and the credit pays everything. Above the plan's free
    // players the app adds its extra-person charge, which the credit pays too: the member is never charged
    const free = Number(elite.plan.freePersons);
    const extraFor = (players: number) => (players > free ? round2((EXTRA_PERSONS_PER_HOUR * BOOKING_MINUTES) / 60) : 0);
    const prices: number[] = [];
    for (const players of [1, 2, 3, ELITE_PLAYERS]) {
      await app.selectGroupSize(modal, players);
      await expect(modal, `${players} player(s): the member credit in the price`).toContainText(/Membership credit/, { timeout: 15_000 });
      const text = await modal.innerText();
      prices.push(sessionPrice(text));
      creditUsed = creditLine(text);
      const extra = money(text.match(/Total Persons \(\d+ total\)\s*\+\s*\$(\d+(?:,\d{3})*\.\d{2})/)?.[1] ?? "0");
      expect(extra, `${players} player(s): extra-person charge with ${free} players free`).toBeCloseTo(extraFor(players), 2);
      expect(creditUsed, `${players} player(s): the credit pays the session and the extra players`).toBeCloseTo(prices[0] + extra, 2);
      expect(discountLine(text).amount, `${players} player(s): no discount on what the credit paid`).toBe(0);
      expect(await app.amountToPay(modal), `${players} player(s): nothing to pay`).toBe(0);
    }
    expect(new Set(prices).size, `the same session price for every group size (${prices.join(", ")})`).toBe(1);
    testInfo.annotations.push({
      type: "price",
      description: `${isoDate(sel.date)} ${sel.startTime}–${sel.endTime} ${sel.bayName}: $${prices[0].toFixed(2)} for ${ELITE_PLAYERS} players (extra players $${extraFor(ELITE_PLAYERS).toFixed(2)}, paid by the credit), credit −$${creditUsed.toFixed(2)}, you pay $0.00 (credit balance $${before.toFixed(2)})`,
    });

    booking1 = await confirmNewBooking(app, testInfo, modal, sel, { groupSize: ELITE_PLAYERS });
    const saved = await app.fetchBooking(booking1.bookingId);
    const p = saved?.paymentBreakdown ?? {};
    testInfo.annotations.push({ type: "saved", description: JSON.stringify({ paymentBreakdown: p, pricing: saved?.metadata?.pricing, membership: saved?.metadata?.membership }).slice(0, 600) });
    expect(Number(saved?.numberOfPersons), "saved players").toBe(ELITE_PLAYERS);
    expect(Number(p.membershipCreditAmount || 0), "saved membership credit").toBeCloseTo(creditUsed, 2);
    expect(Number(p.cardAmount || 0), "nothing from the card").toBe(0);
    expect(Number(p.walletAmount || 0), "nothing from the wallet").toBe(0);
    expect((p.giftCards ?? []).length, "no gift card").toBe(0);
    expect(Number(saved?.metadata?.pricing?.stripeCharged), "Stripe charged nothing").toBe(0);
    expect(Number(saved?.metadata?.pricing?.extraPersonCharge), "saved extra-person charge (paid by the credit)").toBeCloseTo(extraFor(ELITE_PLAYERS), 2);
    expect(saved?.metadata?.membership?.planCode, "booked as Elite").toBe("elite");
    expect(Number(saved?.metadata?.membership?.creditAmount), "credit in the booking's membership details").toBeCloseTo(creditUsed, 2);
    await expect.poll(() => creditBalance(app), { message: `credit balance = $${before.toFixed(2)} − $${creditUsed.toFixed(2)}`, timeout: 20_000 }).toBeCloseTo(round2(before - creditUsed), 2);
    await app.viewMyBooking(booking1);
  });

  test("TC50: cancel booking 1 -> Booking cancelled -> slots free -> the policy's share of the Elite credit comes back", async ({}, testInfo) => {
    test.skip(!booking1, "TC49 did not create booking 1");
    const before = await creditBalance(app);
    const percent = refundPercentFor(minutesUntilStart(app, booking1!));
    const back = creditRefund(await app.fetchBooking(booking1!.bookingId), percent);
    await app.goToDate(booking1!.date);
    await cancelInUi(app, testInfo, booking1!);
    cancelled1 = true;
    expect((await app.fetchBooking(booking1!.bookingId))?.isCancelled, "saved as cancelled").toBe(true);
    await expectBookingGone(app, booking1!);
    await expect
      .poll(() => creditBalance(app), { message: `credit balance = $${before.toFixed(2)} + $${back.toFixed(2)} (${percent}% of $${creditUsed.toFixed(2)})`, timeout: 20_000 })
      .toBeCloseTo(round2(before + back), 2);
    testInfo.annotations.push({ type: "credit", description: `$${before.toFixed(2)} + $${back.toFixed(2)} given back (${percent}%)` });
  });

  test("TC51: booking 2 after credit hours: 15% Elite discount, no credit -> payment -> Booking Confirmed", async ({}, testInfo) => {
    test.skip(!elite, "TC48: not an Elite member");
    const before = await creditBalance(app);
    const wallet = await app.walletBalance();
    const percent = Number(elite.plan.discountPercent);
    await toCalendar(app);
    const sel = await selectRequestedSlot(app, testInfo, [], { bookingMinutes: BOOKING_MINUTES, rescheduleRoom: false, dayWindow: { from: creditHours(elite.plan).to, to: 24 * 60 }, reuseOpenPage: true });
    const modal = await app.openBookingModal(sel);
    await app.readPause();
    await app.selectGroupSize(modal, 2);
    await expect(modal, "the member discount in the price").toContainText(/Member discount/, { timeout: 15_000 });
    const text = await modal.innerText();
    const price = sessionPrice(text);
    const discount = discountLine(text);
    const toPay = await app.amountToPay(modal);
    const final = round2(price - discount.amount);
    const fromWallet = round2(Math.min(wallet, final)); // the wallet pays before the card
    testInfo.annotations.push({
      type: "price",
      description: `${isoDate(sel.date)} ${sel.startTime}–${sel.endTime} ${sel.bayName}: $${price.toFixed(2)} − ${discount.percent}% $${discount.amount.toFixed(2)} = $${final.toFixed(2)}; wallet $${fromWallet.toFixed(2)}, you pay $${toPay.toFixed(2)}`,
    });
    expect(creditLine(text), "no membership credit outside credit hours").toBe(0);
    expect(discount.percent, "Elite discount percent").toBe(percent);
    // The app rounds to cents and cuts the shown amount: at most 1–2 cents off
    expect(Math.abs(discount.amount - (price * percent) / 100), `discount $${discount.amount} = ${percent}% of $${price}`).toBeLessThanOrEqual(0.02);
    expect(Math.abs(toPay - (final - fromWallet)), `"You pay" $${toPay} = $${final} − wallet $${fromWallet}`).toBeLessThanOrEqual(0.02);
    if (toPay === 0) testInfo.annotations.push({ type: "warning", description: "the wallet covers the whole booking: the card payment is NOT tested in this run" });

    booking2 = await confirmNewBooking(app, testInfo, modal, sel, { groupSize: 2, track: suite.track });
    const saved = await app.fetchBooking(booking2.bookingId);
    const p = saved?.paymentBreakdown ?? {};
    testInfo.annotations.push({ type: "saved", description: JSON.stringify({ paymentBreakdown: p, pricing: saved?.metadata?.pricing, membership: saved?.metadata?.membership }).slice(0, 600) });
    expect(Number(p.membershipCreditAmount || 0), "no membership credit saved").toBe(0);
    expect(Math.abs(Number(p.cardAmount || 0) - toPay), `the card paid "You pay" $${toPay}`).toBeLessThanOrEqual(0.02);
    expect(Math.abs(Number(p.walletAmount || 0) - fromWallet), `the wallet paid $${fromWallet}`).toBeLessThanOrEqual(0.02);
    expect(saved?.metadata?.membership?.planCode, "booked as Elite").toBe("elite");
    expect(Number(saved?.metadata?.membership?.discountPercent), "saved discount percent").toBe(percent);
    expect(Math.abs(Number(saved?.metadata?.membership?.memberDiscountAmount) - discount.amount), `saved discount $${discount.amount}`).toBeLessThanOrEqual(0.02);
    expect(Number(saved?.metadata?.membership?.creditAmount || 0), "no credit in the booking's membership details").toBe(0);
    expect(await creditBalance(app), "the credit balance is unchanged").toBeCloseTo(before, 2);
    await app.viewMyBooking(booking2);
  });

  test("TC52: My Booking -> cancel booking 2 -> refund shown and applied -> cancelled, slots free, credit unchanged", async ({}, testInfo) => {
    test.skip(!booking2, "TC51 did not create booking 2");
    const b = booking2!;
    await cancelOnMyBookingPage(app, testInfo, b, "booking 2", () => suite.markCancelled());
  });
});

// ───────────────────────────── cancel and keep the membership ─────────────────────────────

/**
 * Test cases 53–57 — cancel the Elite membership, book while it is cancelled, cancel that booking, keep the membership.
 * Cancelling a membership only stops the renewal: it stays active, with its benefits and credit, until the end of the paid
 * period ("You keep your benefits and credit until then"). So the booking still gets the Elite price (TC55).
 *
 *  TC53  Membership (active Elite) -> "Cancel membership" -> the popup: "Cancel your membership?", benefits until the
 *         period end, the reasons -> a reason is picked -> "Continue" when the app shows one (today it does not: the reasons
 *         and the confirmation are one popup)
 *  TC54  "Cancel membership" in the popup -> POST /membership/cancel with the reason -> "Your membership won't renew" ->
 *         GET /membership/me: cancelAtPeriodEnd, the reason, still active, same credit -> the page: "Ends …", "Keep my membership"
 *  TC55  a booking on a day before the period end, after credit hours: the Elite discount as until the end of the period,
 *         no credit; "You pay" = price − discount − wallet -> Booking Confirmed -> saved amounts; credit unchanged
 *  TC56  My Booking -> that booking -> Modify -> Cancel booking -> refund policy shown and applied -> cancelled, slots free
 *  TC57  "Keep my membership" -> POST /membership/resume -> "Your membership will keep renewing" -> renewing again, as before
 *
 * A run that stops between TC54 and TC57 presses "Keep my membership" at the end, so the account is not left cancelled.
 */
const CANCEL_REASONS = ["Too expensive", "Not using it enough", "Moving away", "Switching to another place", "Just taking a break", "Other"];
const CANCEL_REASON = "Just taking a break";

test.describe("Cancel and keep membership @membership @creates-booking", () => {
  let app: BookingApp;
  const suite = bookingSuite((a) => (app = a), { watch: true });
  let start: any = null; // GET /membership/me before cancelling
  let popupReady = false; // TC53 left the popup open with a reason picked
  let cancelled = false; // the membership is cancelled (TC54) and not kept yet (TC57)
  let booking: CreatedBooking | undefined; // TC55

  const popup = () => app.dialog(/Cancel your membership\?/);
  /** The period end as the page writes it, in the browser's time zone: "Dec 21, 2026" (or "Dec 21"). */
  const endDate = (year = true) =>
    app.page.evaluate(
      ({ iso, year }) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) }),
      { iso: String(start.currentPeriodEnd), year },
    );
  const keepButton = () => app.page.getByRole("button", { name: "Keep my membership", exact: true });

  test.afterAll(async () => {
    if (!app || !cancelled) return;
    try {
      // Opened by its address: the test may have stopped anywhere (a popup, the Booking Confirmed screen: no sidebar)
      await app.page.goto("/membership");
      await keepButton().click({ timeout: 30_000 });
      await expect.poll(async () => (await app.membership())?.cancelAtPeriodEnd, { timeout: 20_000 }).toBe(false);
      console.log("[teetime-e2e] cleanup: membership kept (renewing again)");
    } catch {
      console.log('[teetime-e2e] cleanup: the membership is still CANCELLED: press "Keep my membership" on the Membership page');
    }
  });

  test("TC53: Membership -> Cancel membership -> the popup: benefits until the period end, the reasons, a reason picked", async ({}, testInfo) => {
    requireBookingCreation();
    await app.openIfNeeded();
    start = await app.membership();
    test.skip(!isElite(start), "Not an active Elite member (TC48 upgrades to Elite)");
    // Cancelled with this test's own reason: an earlier run stopped before TC57 -> keep it first, then start as usual.
    // Cancelled with any other reason: somebody else did that, so it is left alone
    const leftOver = start.cancelAtPeriodEnd === true && start.cancelReason === CANCEL_REASON;
    test.skip(
      start.cancelAtPeriodEnd === true && !leftOver,
      `The membership was cancelled outside this test ("${start.cancelReason}"): press "Keep my membership" on the Membership page first`,
    );
    await toMembership(app);
    if (leftOver) {
      console.log("[teetime-e2e] membership: left cancelled by an earlier run; pressing \"Keep my membership\" first");
      testInfo.annotations.push({ type: "membership", description: "left cancelled by an earlier run: kept first" });
      await app.guidedClick(keepButton(), { read: app.readMs });
      await expect.poll(async () => (await app.membership())?.cancelAtPeriodEnd, { message: "renewing again", timeout: 30_000 }).toBe(false);
      start = await app.membership();
    }
    await expect(app.page.getByText("Active", { exact: true }).first(), 'the "Active" badge').toBeVisible({ timeout: 15_000 });
    await expect(app.page.getByText(`Renews ${await endDate()}`, { exact: true }), "the renewal date").toBeVisible();

    await app.guidedClick(app.page.getByRole("button", { name: "Cancel membership", exact: true }), { read: app.readMs });
    await expect(popup(), "the Cancel membership popup").toBeVisible();
    await expect(popup().getByText(`Benefits until ${await endDate()}`), "how long the benefits last").toBeVisible();
    await expect(popup().getByText("Why are you leaving?", { exact: true }), "the reason question").toBeVisible();
    for (const reason of CANCEL_REASONS) await expect(popup().getByText(reason, { exact: true }), `reason "${reason}"`).toBeVisible();
    await expect(popup().getByRole("button", { name: "Keep it", exact: true })).toBeEnabled();

    await app.guidedClick(popup().getByText(CANCEL_REASON, { exact: true }), { read: app.readMs });
    await expect(popup().getByRole("radio", { name: CANCEL_REASON, exact: true }), "the picked reason").toBeChecked();
    await expect(popup().getByRole("radio", { checked: true }), "only one reason is picked").toHaveCount(1);

    const next = app.page.getByRole("dialog").getByRole("button", { name: "Continue", exact: true });
    const hasContinue = await next.isVisible();
    testInfo.annotations.push({ type: "cancel-popup", description: hasContinue ? "reasons -> Continue -> confirmation" : "no Continue button: the reasons and the confirmation are one popup" });
    if (hasContinue) await app.guidedClick(next, { read: app.readMs });
    const confirm = app.page.getByRole("dialog").getByRole("button", { name: "Cancel membership", exact: true });
    await expect(confirm, "the confirmation: Cancel membership").toBeEnabled();
    expect((await app.membership())?.cancelAtPeriodEnd, "nothing is cancelled before the confirmation").toBe(false);
    popupReady = true;
    await app.readPause();
  });

  test("TC54: confirm Cancel membership -> won't renew -> ends at the period end, still active until then", async ({}, testInfo) => {
    test.skip(!popupReady, "TC53 did not open the Cancel membership popup");
    const page = app.page;
    const response = page.waitForResponse((r) => r.request().method() === "POST" && /\/membership\/cancel(\?|$)/.test(r.url()), { timeout: 60_000 });
    await app.guidedClick(page.getByRole("dialog").getByRole("button", { name: "Cancel membership", exact: true }), { read: app.readMs });
    const res = await response;
    const result = `HTTP ${res.status()} ${JSON.stringify(await res.json().catch(() => ({}))).slice(0, 200)}`;
    testInfo.annotations.push({ type: "membership-cancel", description: result });
    expect(res.ok(), `POST /membership/cancel: ${result}`).toBe(true);
    cancelled = true;
    expect(res.request().postDataJSON()?.reason, "the reason sent").toBe(CANCEL_REASON);
    await expect(page.getByText("Your membership won't renew").first(), "the confirmation message").toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog").filter({ hasText: "Why are you leaving?" }), "the popup closes").toBeHidden({ timeout: 15_000 });

    // The API: cancelled at the period end; until then the same active plan and credit
    await expect.poll(async () => (await app.membership())?.cancelAtPeriodEnd, { message: "GET /membership/me: cancelAtPeriodEnd", timeout: 30_000 }).toBe(true);
    const now = await app.membership();
    expect(now.cancelReason, "the saved reason").toBe(CANCEL_REASON);
    expect(now.status, "still active until the period end").toBe("active");
    expect(now.plan?.code, "still Elite until the period end").toBe("elite");
    expect(now.currentPeriodEnd, "the period end is unchanged").toBe(start.currentPeriodEnd);
    expect(Number(now.creditBalance), "the credit is kept").toBeCloseTo(Number(start.creditBalance), 2);

    // The page
    await expect(page.getByText(`Ends ${await endDate()}`, { exact: true }), "when it ends").toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`Ends ${await endDate(false)}`, { exact: true }), "the badge").toBeVisible();
    await expect(page.getByText("Active", { exact: true }), 'no "Active" badge any more').toBeHidden();
    await expect(keepButton(), '"Keep my membership"').toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel membership", exact: true }), "cannot be cancelled twice").toBeHidden();
    await app.readPause();
  });

  test("TC55: a booking while the membership is cancelled: the Elite price until the period end, no credit -> Booking Confirmed", async ({}, testInfo) => {
    test.skip(!cancelled, "TC54 did not cancel the membership");
    const plan = start.plan;
    const before = await creditBalance(app);
    const wallet = await app.walletBalance();
    // Benefits end with the period: only days before that date (in the location's time zone)
    const lastDay = todayIn(app.tz, new Date(start.currentPeriodEnd));
    await toCalendar(app);
    const sel = await selectRequestedSlot(app, testInfo, [], {
      bookingMinutes: BOOKING_MINUTES,
      rescheduleRoom: false,
      dayWindow: { from: creditHours(plan).to, to: 24 * 60 },
      reuseOpenPage: true,
      skipDay: (d) => (compareDates(d, lastDay) >= 0 ? `the membership ends on ${isoDate(lastDay)}` : null),
    });
    const modal = await app.openBookingModal(sel);
    await app.readPause();
    await app.selectGroupSize(modal, 1);
    await expect(modal, "the member discount still applies until the period end").toContainText(/Member discount/, { timeout: 15_000 });
    const text = await modal.innerText();
    const price = sessionPrice(text);
    const discount = discountLine(text);
    const toPay = await app.amountToPay(modal);
    const final = round2(price - discount.amount);
    const fromWallet = round2(Math.min(wallet, final)); // the wallet pays before the card
    testInfo.annotations.push({
      type: "price",
      description: `${isoDate(sel.date)} ${sel.startTime}–${sel.endTime} ${sel.bayName}: $${price.toFixed(2)} − ${discount.percent}% $${discount.amount.toFixed(2)} = $${final.toFixed(2)}; wallet $${fromWallet.toFixed(2)}, you pay $${toPay.toFixed(2)}`,
    });
    expect(creditLine(text), "no membership credit outside credit hours").toBe(0);
    expect(discount.percent, "the Elite discount").toBe(Number(plan.discountPercent));
    expect(Math.abs(discount.amount - (price * Number(plan.discountPercent)) / 100), `discount $${discount.amount} = ${plan.discountPercent}% of $${price}`).toBeLessThanOrEqual(0.02);
    expect(Math.abs(toPay - (final - fromWallet)), `"You pay" $${toPay} = $${final} − wallet $${fromWallet}`).toBeLessThanOrEqual(0.02);

    booking = await confirmNewBooking(app, testInfo, modal, sel, { track: suite.track });
    const saved = await app.fetchBooking(booking.bookingId);
    const p = saved?.paymentBreakdown ?? {};
    const used = saved?.metadata?.membership;
    testInfo.annotations.push({ type: "saved", description: JSON.stringify({ paymentBreakdown: p, membership: used }).slice(0, 500) });
    expect(Number(p.membershipCreditAmount || 0), "no membership credit saved").toBe(0);
    expect(Math.abs(Number(p.cardAmount || 0) - toPay), `the card paid "You pay" $${toPay}`).toBeLessThanOrEqual(0.02);
    expect(Math.abs(Number(p.walletAmount || 0) - fromWallet), `the wallet paid $${fromWallet}`).toBeLessThanOrEqual(0.02);
    expect(used?.planCode, "priced with the plan that is active until the period end").toBe("elite");
    expect(compareDates(sel.date, lastDay), `the booking (${isoDate(sel.date)}) is before the period end (${isoDate(lastDay)})`).toBeLessThan(0);
    expect(await creditBalance(app), "the credit balance is unchanged").toBeCloseTo(before, 2);
    expect((await app.membership())?.cancelAtPeriodEnd, "booking does not renew the membership").toBe(true);
    await app.viewMyBooking(booking);
  });

  test("TC56: My Booking -> cancel that booking -> refund shown and applied -> cancelled, slots free, credit unchanged", async ({}, testInfo) => {
    test.skip(!booking, "TC55 did not create the booking");
    const b = booking!;
    await cancelOnMyBookingPage(app, testInfo, b, "the booking", () => suite.markCancelled());
  });

  test("TC57: Keep my membership -> keeps renewing -> active Elite as before", async ({}, testInfo) => {
    test.skip(!cancelled, "TC54 did not cancel the membership");
    const page = app.page;
    await toMembership(app);
    await expect(page.getByText(`Ends ${await endDate()}`, { exact: true }), "cancelled until now").toBeVisible({ timeout: 15_000 });
    const response = page.waitForResponse((r) => r.request().method() === "POST" && /\/membership\/resume(\?|$)/.test(r.url()), { timeout: 60_000 });
    await app.guidedClick(keepButton(), { read: app.readMs });
    const res = await response;
    const result = `HTTP ${res.status()} ${JSON.stringify(await res.json().catch(() => ({}))).slice(0, 200)}`;
    testInfo.annotations.push({ type: "membership-resume", description: result });
    expect(res.ok(), `POST /membership/resume: ${result}`).toBe(true);
    await expect(page.getByText("Your membership will keep renewing").first(), "the confirmation message").toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await app.membership())?.cancelAtPeriodEnd, { message: "GET /membership/me: renewing again", timeout: 30_000 }).toBe(false);
    cancelled = false;
    const now = await app.membership();
    expect(isElite(now), "active Elite").toBe(true);
    expect(now.currentPeriodEnd, "the same period").toBe(start.currentPeriodEnd);
    expect(Number(now.creditBalance), "the same credit").toBeCloseTo(Number(start.creditBalance), 2);
    await expect(page.getByText("Active", { exact: true }).first(), 'the "Active" badge').toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`Renews ${await endDate()}`, { exact: true }), "the renewal date").toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel membership", exact: true }), "can be cancelled again").toBeVisible();
    await expect(keepButton(), '"Keep my membership" is gone').toBeHidden();
    await app.readPause();
  });
});
