import type { Page } from "@playwright/test";
import { env } from "./env";
import { CREATE_BOOKING_RE } from "./network";

/**
 * Safety net for tests that must NOT create bookings: any POST /booking/:locationId/:bayId is aborted
 * before it reaches staging. The tests still assert that no such request was even attempted.
 */
export async function blockBookingCreation(page: Page) {
  await page.route(
    (url) => url.href.startsWith(env.apiURL) && CREATE_BOOKING_RE.test(url.href),
    (route) => (route.request().method() === "POST" ? route.abort("blockedbyclient") : route.continue()),
  );
}

/** Replace the create-booking response with a simulated failure (no request reaches staging). */
export async function failBookingCreation(page: Page, status: number, body: Record<string, unknown>) {
  await page.route(
    (url) => url.href.startsWith(env.apiURL) && CREATE_BOOKING_RE.test(url.href),
    (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
        : route.continue(),
  );
}

/**
 * Answer every create-booking POST with a simulated success (no request reaches staging, nothing is booked
 * or charged). Returns the list of intercepted POSTs so a test can count them.
 */
export async function fakeBookingSuccess(page: Page, bookingId: string) {
  const posts: string[] = [];
  await page.route(
    (url) => url.href.startsWith(env.apiURL) && CREATE_BOOKING_RE.test(url.href),
    (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, bookingId }) });
    },
  );
  return posts;
}

export const toast =(page: Page, text: string | RegExp) => page.locator("[data-sonner-toast]").filter({ hasText: text });
