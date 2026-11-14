import { expect, type Locator } from "@playwright/test";
import type { BookingApp, CreatedBooking } from "./booking-app";
import { env } from "./env";
import { addDays, fromMinutes, headerLabel, toMinutes } from "./time";

/**
 * The "Extend booking" popup (ExtendBookingModal DurationPicker): one shared value in 15-min slots drives the
 * slider, the + / − buttons, the presets, the "+45 min" label and "Ends …". Used by booking-flow.spec.ts (TC46)
 * and booking-extend-controls.spec.ts.
 */

/** "45 min", "1 hr", "1 hr 15 min" — the app's formatMinutes(). */
export const formatMinutes = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
};

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
export async function expectExtendSelection(popup: Locator, base: CreatedBooking, slots: number) {
  await expect(popup.locator("div.text-2xl"), "additional time label").toHaveText(`+${formatMinutes(slots * 15)}`);
  await expect.poll(async () => Math.round(Number(await slider(popup).inputValue())), { message: "slider position" }).toBe(slots);
  await expect(popup, "new end time").toContainText(`Ends ${extendEndLabel(base, slots)}`);
  await expect(popup, "original end time shown (struck through)").toContainText(base.endTime);
}

/** Drag the slider with the mouse to `slots`, then fine-tune with the arrow keys if the drag landed a step off. */
export async function dragExtendSlider(app: BookingApp, popup: Locator, slots: number, max: number) {
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
  if (env.readMs > 0) await app.readPause();
  return max;
}
