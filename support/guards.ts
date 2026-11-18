import type { Page, Route } from "@playwright/test";
import { env } from "./env";
import { CREATE_BOOKING_RE } from "./network";

/** Route every create-booking POST (POST /booking/:locationId/:bayId) to `onPost`; other methods pass through. */
async function routeCreateBooking(page: Page, onPost: (route: Route) => Promise<void>) {
  await page.route(
    (url) => url.href.startsWith(env.apiURL) && CREATE_BOOKING_RE.test(url.href),
    (route) => (route.request().method() === "POST" ? onPost(route) : route.continue()),
  );
}

/**
 * Safety net for tests that must NOT create bookings: any POST /booking/:locationId/:bayId is aborted
 * before it reaches staging. The tests still assert that no such request was even attempted.
 */
export async function blockBookingCreation(page: Page) {
  await routeCreateBooking(page, (route) => route.abort("blockedbyclient"));
}

/** Replace the create-booking response with a simulated failure (no request reaches staging). */
export async function failBookingCreation(page: Page, status: number, body: Record<string, unknown>) {
  await routeCreateBooking(page, (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
}

/**
 * Answer every create-booking POST with a simulated success (no request reaches staging, nothing is booked
 * or charged). Returns the list of intercepted POSTs so a test can count them.
 */
export async function fakeBookingSuccess(page: Page, bookingId: string) {
  const posts: string[] = [];
  await routeCreateBooking(page, (route) => {
    posts.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, bookingId }) });
  });
  return posts;
}

export const toast = (page: Page, text: string | RegExp) => page.locator("[data-sonner-toast]").filter({ hasText: text });
