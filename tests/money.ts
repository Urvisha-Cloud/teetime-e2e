/**
 * Money helpers shared by every spec: rounding, the price lines of Booking Details, what a saved booking was paid
 * with, and how the app splits a refund. Plain functions (no browser): the specs read the values, these do the sums.
 */

/** Dollars rounded to whole cents (the app shows and saves cents). */
export const round2 = (n: number) => Math.round(n * 100) / 100;

const dollars = (s: string) => Number(s.replace(/,/g, ""));
const AMOUNT = String.raw`\$(\d+(?:,\d{3})*\.\d{2})`;

/** "Session price after discounts" (or "Session price") in Booking Details, before member credit and discount. */
export function sessionPrice(text: string): number {
  const m = text.match(new RegExp(`Session price after discounts\\s*${AMOUNT}`)) ?? text.match(new RegExp(`Session price\\s*${AMOUNT}`));
  if (!m) throw new Error(`No session price in Booking Details: ${text.slice(0, 300)}`);
  return dollars(m[1]);
}

/** The "Membership credit – $x" line (0 when there is none). */
export const creditLine = (text: string) => dollars(text.match(new RegExp(`Membership credit\\s*[–-]\\s*${AMOUNT}`))?.[1] ?? "0");

/** The "Member discount (10% off) - $x" line: amount and percent (0 when there is none). */
export function discountLine(text: string): { amount: number; percent: number } {
  const m = text.match(new RegExp(`Member discount(?:\\s*\\((\\d+)% off\\))?\\s*[–-]\\s*${AMOUNT}`));
  return { amount: dollars(m?.[2] ?? "0"), percent: Number(m?.[1] ?? 0) };
}

/** What Booking Details charges before the wallet and the gift card: session price − member credit − member discount. */
export function dueBeforeWallet(text: string): number {
  return round2(sessionPrice(text) - creditLine(text) - discountLine(text).amount);
}

/** What a saved booking was paid with (its paymentBreakdown); an older booking without one was paid by card. */
export type Payment = { card: number; wallet: number; gift: number; credit: number; total: number };

/** All gift cards of a paymentBreakdown together. */
export const giftTotal = (breakdown: any): number =>
  round2((breakdown?.giftCards ?? []).reduce((sum: number, g: any) => sum + Number(g.amount || 0), 0));

/** How the saved booking was paid: card, wallet, gift cards, member credit and the total. */
export function paidWith(booking: any): Payment {
  const p = booking?.paymentBreakdown;
  const card = Number(p ? p.cardAmount || 0 : booking?.paidAmount || 0);
  const wallet = Number(p?.walletAmount || 0);
  const gift = giftTotal(p);
  const credit = Number(p?.membershipCreditAmount || 0);
  return { card, wallet, gift, credit, total: round2(card + wallet + gift + credit) };
}

/** Where a refund goes: each way of payment after the fee, the total and the fee. */
export type RefundSplit = { total: number; fee: number; card: number; gift: number; wallet: number; credit: number };

/**
 * The refund of a cancellation, split as the app does it (backend calculateRefundBreakdown, the cancel popup's
 * splitRefund): `percent` of everything paid comes back; the fee (the rest) is taken from the card first, then the gift
 * cards, the wallet and last the member credit.
 */
export function refundSplit(paid: Payment, percent: number): RefundSplit {
  const total = round2((paid.total * percent) / 100);
  const fee = round2(paid.total - total);
  let feeLeft = fee;
  const afterFee = (part: number) => {
    const cut = Math.min(feeLeft, part);
    feeLeft = round2(feeLeft - cut);
    return round2(part - cut);
  };
  const card = afterFee(paid.card);
  const gift = afterFee(paid.gift);
  const wallet = afterFee(paid.wallet);
  const credit = afterFee(paid.credit);
  return { total, fee, card, gift, wallet, credit };
}
