import { blockBookingCreation, toast } from "../support/guards";
import { CREATE_BOOKING_RE } from "../support/network";
import { env } from "../support/env";
import { fillBookingModal, requireBookingCreation, selectRequestedSlot } from "./helper";
import { expect, test } from "./fixtures";

/**
 * Payment negative cases. Group-size and waiver validation are covered by TC10 (booking-ui.spec.ts).
 *
 *  - TC18–19: the browser rejects the payment before any booking request is sent (Stripe card check / ZIP check).
 *  - TC20–24: the request reaches the dev API with one of Stripe's published TEST cards that is declined on charge.
 *    The backend creates the booking as "pending", Stripe declines, the backend deletes it again and answers with
 *    Stripe's message, which the app shows as an error toast. Each test checks the message, that the user stays in
 *    the booking modal, and that no booking is left on the account.
 *
 * Stripe test cards: https://docs.stripe.com/testing#declined-payments (dev Stripe runs in test mode).
 */
const TEST_EXP = "1234"; // 12/34
const TEST_CVC = "123";
const TEST_ZIP = "12345";
/** A Stripe test card number with the test expiry / CVC and a ZIP code. */
const testCard = (card: string, zip = TEST_ZIP) => ({ card, exp: TEST_EXP, cvc: TEST_CVC, zip });

test.describe("Payment errors (no booking is created)", () => {
  test("TC18: invalid card number is rejected before the booking request is sent", async ({ app, page }, testInfo) => {
    await blockBookingCreation(page);
    const sel = await selectRequestedSlot(app, testInfo);
    // Same as Stripe's 4242 test number with the last digit changed, so the card number check fails.
    const modal = await fillBookingModal(app, testInfo, sel, { card: testCard("4242424242424241") });
    await app.confirmButton(modal).click();

    await expect(toast(page, /card number is invalid/i)).toBeVisible();
    await expect(modal).toBeVisible();
    await expect(page).toHaveURL(/\/book-now$/);
    expect(app.api.createRequests.length, "no booking request may be sent").toBe(0);
  });

  test("TC19: missing ZIP code is rejected before the booking request is sent", async ({ app, page }, testInfo) => {
    await blockBookingCreation(page);
    const sel = await selectRequestedSlot(app, testInfo);
    const modal = await fillBookingModal(app, testInfo, sel, { card: testCard("4242424242424242", "") });
    await app.confirmButton(modal).click();

    await expect(modal.getByText("Please enter a valid ZIP Code")).toBeVisible();
    await expect(page).toHaveURL(/\/book-now$/);
    expect(app.api.createRequests.length, "no booking request may be sent").toBe(0);
  });

  test("TC25: booking without a group size is blocked before the booking request is sent", async ({ app, page }, testInfo) => {
    await blockBookingCreation(page);
    const sel = await selectRequestedSlot(app, testInfo);
    const modal = await app.openBookingModal(sel);
    // Everything else is valid (waiver ticked, valid test card) — only the group size is missing.
    await app.acceptWaiver(modal);
    await app.enterCard(modal, testCard("4242424242424242"));
    await app.confirmButton(modal).click();

    await expect(modal.getByText("Please select a group size to proceed with your booking.")).toBeVisible();
    await expect(toast(page, "Please select your group size")).toBeVisible();
    await expect(modal).toBeVisible();
    await expect(page).toHaveURL(/\/book-now$/);
    expect(app.api.createRequests.length, "no booking request may be sent").toBe(0);
  });

  const declines = [
    { id: "TC20", name: "insufficient funds", card: "4000000000009995", message: /insufficient funds/i },
    { id: "TC21", name: "generic decline", card: "4000000000000002", message: /card was declined/i },
    { id: "TC22", name: "expired", card: "4000000000000069", message: /card has expired/i },
    { id: "TC23", name: "incorrect CVC", card: "4000000000000127", message: /security code is incorrect/i },
    { id: "TC24", name: "processing error", card: "4000000000000119", message: /error occurred while processing your card/i },
  ];

  for (const d of declines) {
    test(`${d.id}: ${d.name} card shows the error and leaves no booking @creates-booking`, async ({ app, page }, testInfo) => {
      requireBookingCreation(); // sends a real create request to the dev API (the booking is deleted again on decline)
      const before = await app.myActiveBookingIds();

      const sel = await selectRequestedSlot(app, testInfo);
      const modal = await fillBookingModal(app, testInfo, sel, { card: testCard(d.card) });

      const responsePromise = page.waitForResponse(
        (r) => r.request().method() === "POST" && r.url().startsWith(env.apiURL) && CREATE_BOOKING_RE.test(r.url()),
        { timeout: 60_000 },
      );
      await app.confirmButton(modal).click();
      const response = await responsePromise;
      const body = await response.json().catch(() => ({}));
      testInfo.annotations.push({ type: "api-response", description: `HTTP ${response.status()} ${JSON.stringify(body).slice(0, 200)}` });

      // The API refuses the booking with Stripe's decline message...
      expect(response.ok() && body?.success === true, "create booking must fail for a declined card").toBe(false);
      // ...the user sees it, stays in the booking modal and is not sent to the confirmation screen...
      await expect(toast(page, d.message)).toBeVisible();
      await expect(modal).toBeVisible();
      await expect(page).toHaveURL(/\/book-now$/);
      expect(app.api.createRequests.length, "exactly one create request").toBe(1);
      // ...and no booking is left on the account.
      await expect
        .poll(async () => (await app.myActiveBookingIds()).filter((id) => !before.includes(id)), {
          message: "no new active booking after the declined payment",
          timeout: 20_000,
        })
        .toEqual([]);
    });
  }
});
