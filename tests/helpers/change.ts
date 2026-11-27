// Changing a booking: the ⋮ menu, Reschedule / Extend details, reschedule, group size, extend and its popup controls.
import type { Locator, TestInfo } from "@playwright/test";
import { BookingApp, durationValue, type CreatedBooking } from "../../support/booking-app";
import { env } from "../../support/env";
import { addDays, fromMinutes, headerLabel, toMinutes } from "../../support/time";
import { expect } from "../fixtures";
import { orBlocked } from "./suite";
import { atTime, extendedBy } from "./slots";
import { expectConfirmed } from "./create";
import { applyGiftCode } from "./gift-card";
import { showBookingEmail } from "./email";

type ChangeKind = "reschedule" | "extend";

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
 * group size (reschedule; `pickGroupSize` clicks it here), `giftCode` applied first ("Have a gift card?") so the gift
 * card pays the difference, payment only when "You pay" is above $0.00, waiver -> Confirm -> PATCH /booking/<kind>/:id
 * -> Booking Confirmed for `b`. Returns "You pay" before and after the gift card (null without one).
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
    // Clicking the size that is already chosen keeps it (GroupSizeSelector sets the size, it does not toggle)
    if (pickGroupSize) await app.selectGroupSize(details, b.groupSize);
    else await app.verifyGroupSize(details, b.groupSize);
  }
  // The gift card pays (part of) the difference first, when one is given and something is due
  const gift = giftCode ? await applyGiftCode(app, testInfo, details, giftCode, { onRefused: "continue" }) : null;
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

/** The extra time the popup opens with: 30 min, or 15 min when only that is free (ExtendBookingModal defaultExtendSlots). */
export const defaultExtendSlots = (max: number) => Math.max(1, Math.min(2, max));

const slider = (popup: Locator) => popup.getByRole("slider", { name: "Additional time" });

/** The label, the slider position and "Ends …" all show `slots`; the original end time is still shown. */
async function expectExtendSelection(popup: Locator, base: CreatedBooking, slots: number) {
  await expect(durationValue(popup, "additional time"), "additional time label").toHaveText(`+${formatMinutes(slots * 15)}`);
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
 *  start at the default +30 min (+15 min, "−" disabled, when only that is free) · "+" up to +1 hr · "−" one step · every preset that fits · "+" to the maximum
 *  ("+" disabled; past midnight the end shows the weekday) · back to the minimum · slider drag to `finalSlots`
 * Returns the maximum in slots.
 */
export async function exerciseExtendControls(app: BookingApp, popup: Locator, base: CreatedBooking, finalSlots: number) {
  const plus = popup.getByRole("button", { name: "Add 15 minutes" });
  const minus = popup.getByRole("button", { name: "Remove 15 minutes" });
  const max = Number(await slider(popup).getAttribute("max"));
  expect(max, `the popup must offer at least ${formatMinutes(finalSlots * 15)}`).toBeGreaterThanOrEqual(finalSlots);
  await expect(popup, "slider's right end shows the maximum").toContainText(formatMinutes(max * 15));

  // Starts at the default
  const start = defaultExtendSlots(max);
  await expectExtendSelection(popup, base, start);
  if (start > 1) await expect(minus, "− enabled at the default").toBeEnabled();
  else await expect(minus, "− disabled at the minimum").toBeDisabled();
  await app.readPause();

  // "+" up to +1 hr (or the maximum), then "−" one step
  const up = Math.min(4, max);
  for (let i = start; i < up; i++) await app.guidedClick(plus);
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
