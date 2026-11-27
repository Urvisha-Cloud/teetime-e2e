// Suite setup: one booking per group (cleanup), the booking-creation guard, dev-data blocks as skips.
import type { TestInfo } from "@playwright/test";
import { BlockedError, BookingApp, annotateBlocked } from "../../support/booking-app";
import { bookingCreationBlockedReason, env } from "../../support/env";
import { test } from "../fixtures";

// ───────────────────────────── suite setup ─────────────────────────────

export function bookingSuite(onApp: (app: BookingApp) => void, { watch = false, timeout = 240_000 } = {}) {
  test.describe.configure({ mode: "serial", timeout });
  let app: BookingApp | undefined;
  let bookingId: string | undefined;
  let cancelled = false;

  test.beforeAll(async ({ sharedContext }) => {
    app = new BookingApp(sharedContext.pages()[0] ?? (await sharedContext.newPage()));
    app.watch = watch;
    onApp(app);
    // A test that stopped early (skipped, failed) can leave a modal open, which blocks the next group's clicks
    const leftOpen = app.page.locator('[role="dialog"][data-state="open"], #teetime-gift-prompt, #teetime-wallet-prompt');
    if ((await leftOpen.count()) > 0 && app.page.url().startsWith(env.baseURL)) {
      await app.page.goto("/book-now");
      await app.waitForBookingUi();
    }
  });

  test.afterEach(async ({}, testInfo) => {
    if (app && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("failure.png", { body: await app.page.screenshot({ fullPage: true }), contentType: "image/png" });
    }
  });

  test.afterAll(async () => {
    if (app && bookingId && env.cleanup && !cancelled) {
      const res = await app.cancelBooking(bookingId);
      console.log(`[teetime-e2e] cleanup: cancel ${bookingId}: HTTP ${res.status}`);
    }
    app?.api.detach(); // the window stays open for the next tests; it is closed once at the end of the run
  });

  return {
    track(b: { bookingId: string }) {
      bookingId = b.bookingId;
    },
    markCancelled() {
      cancelled = true;
    },
  };
}

/** Skip creation tests unless staging + explicit opt-in. */
export function requireBookingCreation() {
  const reason = bookingCreationBlockedReason();
  test.skip(!!reason, reason ?? "");
}

/** Converts a staging-data problem (no free slot, date not allowed, no saved card) into a reported BLOCKED skip. */
export async function orBlocked<T>(testInfo: TestInfo, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BlockedError) {
      annotateBlocked(testInfo, e.message);
      test.skip(true, e.message);
    }
    throw e;
  }
}
