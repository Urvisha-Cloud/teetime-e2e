import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const str = (name: string, fallback = ""): string =>
  (process.env[name] ?? fallback).trim();

/** Fast run (npm run test:fast): every pause that is only there to watch the run is 0, whatever .env says. */
const fast = str("TEETIME_FAST").toLowerCase() === "true";
/** A pause for watching the run (ms); 0 in a fast run or when empty. */
const watchMs = (name: string, fallback: string): number => (fast ? 0 : Number(str(name, fallback)) || 0);

/** Hosts that count as non-production. Anything else is treated as production. */
const NON_PROD_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$|(^|[.-])(dev|develop|staging|stage|qa|test|uat)[.-]|\.localhost$|\.test$/i;

export const env = {
  baseURL: str("TEETIME_BASE_URL", "https://dev-booking.teetimeindoorgolf.com").replace(/\/$/, ""),
  apiURL: str("TEETIME_API_URL", "https://dev-booking-api.teetimeindoorgolf.com").replace(/\/$/, ""),
  allowBookingCreation: str("TEETIME_ALLOW_BOOKING_CREATION") === "true",

  locationName: str("TEETIME_LOCATION_NAME", "Tee Time - Honolulu"),
  /** Length of the test booking, and of the reschedule time (which starts right where the booking ends). */
  bookingMinutes: 60,
  rescheduleMinutes: 120,
  slotStart: "",
  slotEnd: "",
  rescheduleStart: "",
  rescheduleEnd: "",
  /** Quick pick pressed in the "Extend Booking" popup: "+30 min", "+1 hr", "+2 hr" or "+3 hr". */
  extendBy: str("TEETIME_EXTEND_BY", "+30 min"),
  /** New group size for the group-size update steps (players can only be added: more than the booking has, max 5). */
  groupSizeUpdate: Number(str("TEETIME_GROUP_SIZE_UPDATE", "5")) || 5,
  daysAhead: Number(str("TEETIME_DAYS_AHEAD", "0")),
  minLeadMinutes: Number(str("TEETIME_MIN_LEAD_MINUTES", "270")),
  browserTz: str("TEETIME_BROWSER_TZ", "Pacific/Honolulu"),

  testEmail: str("TEETIME_TEST_EMAIL"),
  giftCardCode: str("TEETIME_GIFT_CARD_CODE"),
  testOtp: str("TEETIME_TEST_OTP"),

  authMode: (str("TEETIME_AUTH_MODE", "signup") === "saved" ? "saved" : "signup") as "signup" | "saved",
  signup: {
    emailPrefix: str("TEETIME_SIGNUP_EMAIL_PREFIX", "teetime-e2e"),
    emailDomain: str("TEETIME_SIGNUP_EMAIL_DOMAIN", "yopmail.com"),
    firstName: str("TEETIME_SIGNUP_FIRST_NAME", "E2E"),
    lastName: str("TEETIME_SIGNUP_LAST_NAME", "Tester"),
    phone: str("TEETIME_SIGNUP_PHONE", "5555550123"), // the form requires exactly 10 digits
  },
  storageState: path.resolve(__dirname, "..", str("TEETIME_STORAGE_STATE", ".auth/staging-user.json")),
  chromeProfile: str("TEETIME_CHROME_PROFILE") ? path.resolve(__dirname, "..", str("TEETIME_CHROME_PROFILE")) : "",

  paymentMode: str("TEETIME_PAYMENT_MODE", "saved-card") as "saved-card" | "test-card",
  stripe: {
    card: str("TEETIME_STRIPE_TEST_CARD"),
    exp: str("TEETIME_STRIPE_TEST_EXP"),
    cvc: str("TEETIME_STRIPE_TEST_CVC"),
    zip: str("TEETIME_STRIPE_TEST_ZIP"),
  },
  cleanup: str("TEETIME_CLEANUP") === "true",
  /** TEETIME_FAST=true (npm run test:fast): the same checks without the watching extras below, so a run is minutes shorter. */
  fast,
  /** How long the journey test keeps the confirmation screen and the booked calendar on screen (ms). */
  showMs: watchMs("TEETIME_SHOW_MS", "3000"),
  emailArriveMs: watchMs("TEETIME_EMAIL_ARRIVE_MS", "1000"),
  /** The same for a NEW booking's email, which takes longer to arrive. */
  newBookingEmailArriveMs: watchMs("TEETIME_NEW_BOOKING_EMAIL_ARRIVE_MS", "8000"),
  /** Watching a headed run: pause on each modal so it can be read. 0 = no pauses. */
  readMs: watchMs("TEETIME_READ_MS", "1000"),
  /** Draw a visible mouse cursor (arrow + click pulse) in the test browser; Playwright's window shows none. */
  showCursor: !fast && str("TEETIME_SHOW_CURSOR", "true").toLowerCase() !== "false",
  /** Bring each booking email up in a YopMail window (headed runs; the test never reads it). Off: TEETIME_SHOW_EMAILS=false. */
  showEmails: !fast && str("TEETIME_SHOW_EMAILS", "true").toLowerCase() !== "false",
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
