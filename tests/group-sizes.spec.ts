import { env } from "../support/env";
import { blockBookingCreation } from "../support/guards";
import { expect, selectRequestedSlot, test } from "./fixtures";

/**
 * Test cases 1–5: every supported group size (1..5) can be chosen in the Booking Details modal and makes
 * the booking ready to confirm. Read-only: Confirm is NOT pressed, a route guard aborts any create request,
 * and each test asserts none was attempted. The one real booking per run is made by TC11 (booking-journey).
 */
test.describe("Group sizes (no booking created)", () => {
  test.beforeEach(async ({ page }) => {
    await blockBookingCreation(page);
  });

  test.afterEach(async ({ app }) => {
    expect(app.api.createRequests.length, "read-only test must not attempt to create a booking").toBe(0);
  });

  for (const size of env.groupSizes) {
    test(`TC${size}: group size ${size} can be selected and the booking is ready to confirm`, async ({ app }, testInfo) => {
      const sel = await selectRequestedSlot(app, testInfo);
      const modal = await test.step("Open booking modal (Book Now)", () => app.openBookingModal(sel));
      await test.step(`Select group size ${size}`, async () => {
        await app.selectGroupSize(modal, size);
        await app.verifyGroupSize(modal, size);
      });
      await test.step("Tick the waiver checkbox", () => app.acceptWaiver(modal));
      await expect(app.confirmButton(modal)).toBeEnabled();
    });
  }
});
