import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const str = (name: string, fallback = ""): string =>
  (process.env[name] ?? fallback).trim();

/** Hosts that count as non-production. Anything else is treated as production. */
const NON_PROD_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$|(^|[.-])(dev|develop|staging|stage|qa|test|uat)[.-]|\.localhost$|\.test$/i;

export const env = {
  baseURL: str("TEETIME_BASE_URL", "https://dev-booking.teetimeindoorgolf.com").replace(/\/$/, ""),
  apiURL: str("TEETIME_API_URL", "https://dev-booking-api.teetimeindoorgolf.com").replace(/\/$/, ""),
  allowBookingCreation: str("TEETIME_ALLOW_BOOKING_CREATION") === "true",

  locationName: str("TEETIME_LOCATION_NAME", "Tee Time - Honolulu"),
  slotStart: str("TEETIME_SLOT_START", "8:00 PM"),
  slotEnd: str("TEETIME_SLOT_END", "9:00 PM"),
  /** New time for the reschedule test (same bay, same date); must be free and on a 15-minute boundary. */
  rescheduleStart: str("TEETIME_RESCHEDULE_START", "9:00 PM"),
  rescheduleEnd: str("TEETIME_RESCHEDULE_END", "11:00 PM"),
  /** Quick pick pressed in the "Extend Booking" popup: "+30 min", "+1 hr", "+2 hr" or "+3 hr". */
  extendBy: str("TEETIME_EXTEND_BY", "+30 min"),
  /** Group size chosen in "Reschedule details" during the reschedule (TC30). */
  rescheduleGroupSize: Number(str("TEETIME_RESCHEDULE_GROUP_SIZE", "4")) || 4,
  /** New group size for the group-size update test (players can only be added: must be > rescheduleGroupSize, max 5). */
  groupSizeUpdate: Number(str("TEETIME_GROUP_SIZE_UPDATE", "5")) || 5,
  daysAhead: Number(str("TEETIME_DAYS_AHEAD", "1")),
  browserTz: str("TEETIME_BROWSER_TZ", "Pacific/Honolulu"),
  groupSizes: str("TEETIME_GROUP_SIZES", "1,2,3,4,5")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 5),

  testEmail: str("TEETIME_TEST_EMAIL"),
  testOtp: str("TEETIME_TEST_OTP"),

  /**
   * How the run logs in:
   *  - "signup" (default): sign up a brand-new user every run (unique yopmail address, signup form, code TEETIME_TEST_OTP)
   *    in the shared Chrome window before the tests. Needs TEST_OTP set on the dev backend.
   *  - "saved": reuse the login saved by `npm run auth` (TEETIME_STORAGE_STATE).
   */
  authMode: (str("TEETIME_AUTH_MODE", "signup") === "saved" ? "saved" : "signup") as "signup" | "saved",
  signup: {
    emailPrefix: str("TEETIME_SIGNUP_EMAIL_PREFIX", "teetime-e2e"),
    emailDomain: str("TEETIME_SIGNUP_EMAIL_DOMAIN", "yopmail.com"),
    firstName: str("TEETIME_SIGNUP_FIRST_NAME", "E2E"),
    lastName: str("TEETIME_SIGNUP_LAST_NAME", "Tester"),
    phone: str("TEETIME_SIGNUP_PHONE", "5555550123"), // the form requires exactly 10 digits
  },
  storageState: path.resolve(__dirname, "..", str("TEETIME_STORAGE_STATE", ".auth/staging-user.json")),

  paymentMode: str("TEETIME_PAYMENT_MODE", "saved-card") as "saved-card" | "test-card",
  stripe: {
    card: str("TEETIME_STRIPE_TEST_CARD"),
    exp: str("TEETIME_STRIPE_TEST_EXP"),
    cvc: str("TEETIME_STRIPE_TEST_CVC"),
    zip: str("TEETIME_STRIPE_TEST_ZIP"),
  },
  cleanup: str("TEETIME_CLEANUP") === "true",
  /** How long the journey test keeps the confirmation screen and the booked calendar on screen (ms). */
  showMs: Number(str("TEETIME_SHOW_MS", "3000")) || 0,
};

export function isNonProductionHost(url: string): boolean {
  try {
    return NON_PROD_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Hard guard for any test that can create a booking.
 * Returns a reason string when creation must NOT happen, or null when it is allowed.
 */
export function bookingCreationBlockedReason(): string | null {
  if (!isNonProductionHost(env.baseURL) || !isNonProductionHost(env.apiURL)) {
    return `Refusing to create bookings: ${env.baseURL} / ${env.apiURL} does not look like a dev/staging host.`;
  }
  if (!env.allowBookingCreation) {
    return "Booking creation disabled. Set TEETIME_ALLOW_BOOKING_CREATION=true to run @creates-booking tests.";
  }
  if (
    env.paymentMode === "test-card" &&
    !(env.stripe.card && env.stripe.exp && env.stripe.cvc && env.stripe.zip)
  ) {
    // Only Stripe's published test cards belong here; staging uses a pk_test_ key.
    return "TEETIME_PAYMENT_MODE=test-card requires TEETIME_STRIPE_TEST_CARD/EXP/CVC/ZIP (Stripe published test values).";
  }
  return null;
}
