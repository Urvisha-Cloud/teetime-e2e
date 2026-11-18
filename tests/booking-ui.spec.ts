import { env } from "../support/env";
import { blockBookingCreation, toast } from "../support/guards";
import { headerLabel, isoDate } from "../support/time";
import { selectRequestedSlot } from "./helper";
import { expect, test } from "./fixtures";

/**
 * Test cases 6, 7 and 10 — read-only: they never create a booking. (The waiver page is not opened;
 * the tests only tick the waiver checkbox.)
 * A route guard aborts any POST /booking/:locationId/:bayId, and each test also asserts none was attempted.
 */
test.describe("Booking UI (no booking created)", () => {
  test.beforeEach(async ({ page }) => {
    await blockBookingCreation(page);
  });

  test.afterEach(async ({ app }) => {
    expect(app.api.createRequests.length, "read-only test must not attempt to create a booking").toBe(0);
  });

  test("TC6: header shows the selected location, date and requested time", async ({ app }, testInfo) => {
    // Location + date are shown in CalenderHeader only while nothing is selected, so check them first.
    await app.open();
    await app.selectLocation(env.locationName);
    const loc = await app.verifyLocationData(env.locationName);
    await expect(app.locationButton()).toContainText(env.locationName);
    if (loc.timezone?.label) await expect(app.locationButton()).toContainText(loc.timezone.label);

    const sel = await selectRequestedSlot(app, testInfo); // re-opens, then selects bay + 8–9 PM
    testInfo.annotations.push({ type: "selection", description: `${sel.bayName} ${isoDate(sel.date)} ${sel.startTime}-${sel.endTime}` });

    // After selection the header switches to "Book Now $x.xx" + "Cancel"; the grid shows the range label.
    await app.verifySelectionHeader(sel);
    await expect(app.page.getByRole("button", { name: "Cancel" })).toBeVisible();

    // Cancelling the selection restores the location/date header for the same date.
    await app.page.getByRole("button", { name: "Cancel" }).click();
    await expect(app.bookNowButton()).toHaveCount(0);
    await expect(app.locationButton()).toContainText(env.locationName);
    expect(headerLabel(await app.displayedDate())).toBe(headerLabel(sel.date));
  });

  test("TC7: Book Now opens the Booking Details modal with the correct details", async ({ app }, testInfo) => {
    const sel = await selectRequestedSlot(app, testInfo);
    const modal = await app.openBookingModal(sel); // asserts details + that no booking request was sent
    await expect(modal.getByText(/Bay Type/)).toBeVisible();
    await expect(modal.getByText("You pay")).toBeVisible();
    await expect(app.waiverCheckbox(modal)).not.toBeChecked();
    for (const n of [1, 2, 3, 4, 5]) await expect(app.groupSizeButton(modal, n)).toBeEnabled();

    // Closing the modal keeps the user on the calendar and creates nothing.
    await modal.getByRole("button", { name: "Cancel" }).click();
    await expect(modal).toBeHidden();
    await expect(app.page).toHaveURL(/\/book-now$/);
  });

  test("TC10: Confirm is blocked until a group size is chosen and the waiver is accepted", async ({ app }, testInfo) => {
    const sel = await selectRequestedSlot(app, testInfo);
    const modal = await app.openBookingModal(sel);
    const confirm = app.confirmButton(modal);

    // 1) No group size -> group-size validation
    await confirm.click();
    await expect(modal.getByText("Please select a group size to proceed with your booking.")).toBeVisible();
    await expect(toast(app.page, "Please select your group size")).toBeVisible();

    // 2) Group size chosen, waiver NOT accepted -> waiver validation
    await app.selectGroupSize(modal, 1);
    await expect(modal.getByText("Please select a group size to proceed with your booking.")).toHaveCount(0);
    await confirm.click();
    await expect(modal.getByText("You must agree to the waiver before confirming your booking.")).toBeVisible();

    // 3) Ticking the checkbox clears the error (the waiver page itself is not opened)
    await app.acceptWaiver(modal);
    await expect(modal).toBeVisible();
    await expect(app.page).toHaveURL(/\/book-now$/);
  });
});
