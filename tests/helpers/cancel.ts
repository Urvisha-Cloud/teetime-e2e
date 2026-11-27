// Cancelling: the refund policy, the cancel popup's refund lines, the cancellation and the slots free again.
import type { Locator, TestInfo } from "@playwright/test";
import { BookingApp, type CreatedBooking } from "../../support/booking-app";
import { env } from "../../support/env";
import { compareDates, nowMinutesIn, todayIn, toMinutes } from "../../support/time";
import { expect } from "../fixtures";
import { type RefundSplit, paidWith, refundSplit, round2 } from "../money";
import { clickAndExpectPatch, manageBooking } from "./change";
import { showBookingEmail } from "./email";

// ───────────────────────────── cancel ─────────────────────────────

// ───────────────────────────── refund policy ─────────────────────────────
// The cancellation refund rules, the same as the backend (getRefundPercentByTime) and the "How refunds work" list in
// the cancel popup (CancellationPolicyModal). New cancel scenarios reuse these: book a slot, openCancelDialog(),
// expectRefundShown(), then cancelInUi().

/** Refund tiers, highest first: from `minMinutes` before the start, `percent` of what was paid comes back. */
export const REFUND_TIERS = [
  { minMinutes: 240, percent: 90, title: "90% refund", text: "More than 4 hours before the start time" },
  { minMinutes: 60, percent: 50, title: "50% refund", text: "Between 1 and 4 hours before the start time" },
  { minMinutes: 0, percent: 0, title: "No refund", text: "Within 1 hour of the start time" },
] as const;

/** Refund percent for a cancellation `minutesBeforeStart` before the booking starts. */
export const refundPercentFor = (minutesBeforeStart: number): number =>
  (REFUND_TIERS.find((t) => minutesBeforeStart >= t.minMinutes) ?? REFUND_TIERS[REFUND_TIERS.length - 1]).percent;

/** The cancel popup's refund lines: amount per way of payment (only the ones shown). */
export type RefundLines = Partial<Record<"Card" | "Gift card" | "Wallet", number>>;

/** Minutes from now until `b` starts, in the location's time zone. */
export function minutesUntilStart(app: BookingApp, b: CreatedBooking): number {
  const days = compareDates(b.date, todayIn(app.tz)) / 86_400_000;
  return days * 24 * 60 + toMinutes(b.startTime) - nowMinutesIn(app.tz);
}


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
export async function expectRefundShown(app: BookingApp, testInfo: TestInfo, cancel: Locator, b: CreatedBooking, refundLines?: RefundLines) {
  const minutes = minutesUntilStart(app, b);
  const percent = refundPercentFor(minutes);
  const booking = await app.fetchBooking(b.bookingId);
  const split = refundSplit(paidWith(booking), percent);
  const paid = paidWith(booking).total;
  const amount = split.total;
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
    await expectRefundLines(cancel, booking, split, refundLines);
    if (percent === 90) await expect(cancel).toContainText("Includes a 10% payment processing and digital service fee");
    await expect(cancel).toContainText("Refunds are processed automatically");
  } else {
    await expect(cancel, "non-refundable notice").toContainText("non-refundable");
    await expect(cancel, "no refund total").not.toContainText("Total refund");
  }
  await app.readPause();
  return { percent, amount, minutes, paid, split };
}

/**
 * The cancel popup's refund lines, one per way the money goes back ("Gift card $27.00", "Card $3.00", "Wallet …"):
 * each is a way the booking was paid, and together they make the total refund. The fee is taken from the card first
 * (refundSplit), so a booking paid by gift card + card can show only a "Gift card" line (e.g. 90% of $27 + $3 = $27,
 * all to the gift card). Without member credit (which has its own line) every line must be exactly the split's
 * amount; `expected` overrides that.
 */
async function expectRefundLines(cancel: Locator, booking: any, split: RefundSplit, expected?: RefundLines) {
  const total = split.total;
  const p = booking?.paymentBreakdown ?? {};
  const paid = paidWith(booking);
  const paidWithLine = { "Gift card": paid.gift, Wallet: paid.wallet, Card: paid.card } as Record<string, number>;
  if (!expected && paid.credit === 0) {
    expected = {};
    if (split.card > 0) expected.Card = split.card;
    if (split.wallet > 0) expected.Wallet = split.wallet;
    if (split.gift > 0) expected["Gift card"] = split.gift;
  }
  const text = await cancel.innerText();
  const refundPart = text.slice(text.indexOf("Total refund"));
  const lines = [...refundPart.matchAll(/^\s*(Gift card|Wallet[^\n$]*|Card)\s*\n?\s*\$(\d+(?:,\d{3})*\.\d{2})/gim)].map((m) => ({
    method: /^gift/i.test(m[1]) ? "Gift card" : /^wallet/i.test(m[1]) ? "Wallet" : "Card",
    amount: Number(m[2].replace(/,/g, "")),
  }));
  expect(lines.length, `refund lines in the cancel popup (${refundPart.slice(0, 200).replace(/\s+/g, " ")})`).toBeGreaterThan(0);
  for (const line of lines) {
    expect(paidWithLine[line.method], `the ${line.method} refund line is a way the booking was paid (${JSON.stringify(p)})`).toBeGreaterThan(0);
  }
  expect(round2(lines.reduce((sum, l) => sum + l.amount, 0)), "the refund lines add up to the total refund").toBeCloseTo(total, 2);
  if (expected) expect(Object.fromEntries(lines.map((l) => [l.method, l.amount])), "the refund line of each way of payment").toEqual(expected);
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
  /** `refundLines`: the exact refund line per way of payment (implies checkRefund). Returns the refund checked, if any. */
  { checkRefund = false, expectPercent, refundLines }: { checkRefund?: boolean; expectPercent?: number; refundLines?: RefundLines } = {},
) {
  const cancel = await openCancelDialog(app, b);
  const expected = checkRefund || expectPercent !== undefined || refundLines ? await expectRefundShown(app, testInfo, cancel, b, refundLines) : null;
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
  return expected;
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
