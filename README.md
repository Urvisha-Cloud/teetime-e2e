# TeeTime staging booking — Playwright E2E

Black-box Playwright + TypeScript tests for the bay-booking flow on
`https://dev-booking.teetimeindoorgolf.com`. No application code is changed; selectors come from the
shipped UI (the staging bundle's public source maps were used to read the components).

## Setup (one time, Node.js 18+)

```bash
npm install
npx playwright install chromium
cp .env.example .env          # then edit .env (see below)
npm run auth                  # headed: type the 4-digit email code once; saves .auth/staging-user.json
```

Set at least these in `.env`:

```
TEETIME_TEST_EMAIL=<test account email>
TEETIME_ALLOW_BOOKING_CREATION=true
TEETIME_PAYMENT_MODE=saved-card
TEETIME_CLEANUP=true
```

Keep `TEETIME_API_URL` ending in **`/v1`** (`https://dev-booking-api.teetimeindoorgolf.com/v1`); without it the
cleanup cancel call gets HTTP 404 and test bookings stay active.

**Gift cards:** visible runs ask for each gift card code in a popup. Headless runs read them from `.env` and need
three different cards, because each step needs a different balance: `TEETIME_GIFT_CARD_CODE` (gift card checkout
TC35–40: booking + reschedule + extension, at least the price of 2.5 hours at the bay), `TEETIME_SMALL_GIFT_CARD_CODE` (TC33–34: a few dollars, so
the card still pays a part) and `TEETIME_REDEEM_GIFT_CODE` (TC25: redeemed into the wallet, which uses it up).

**Login modes (`TEETIME_AUTH_MODE` in .env):**

* `signup` (default): **one test user, reused across runs.** The first run signs up `teetime-e2e-<timestamp>@yopmail.com`
  (login popup -> signup form: name, phone, location -> code **1111** -> calendar) and remembers the email in
  `.auth/e2e-user.json`. Later runs only log in with that email + code 1111. If the user was deleted from the DB the
  popup shows the signup form and the same email is signed up again; if it is blocked, a new user is created.
  Delete `.auth/e2e-user.json` to start with a brand-new user. Pays with Stripe test card `4242...`
  (`TEETIME_PAYMENT_MODE=test-card`). Needs `TEST_OTP=1111` on the **dev backend** (booking-backend). The fixed code applies
  only to emails starting with `teetime-e2e-` (`TEST_OTP_EMAIL_PREFIX`); everyone else keeps getting a random emailed code.
  The new user's inbox: https://yopmail.com (address printed in the run output).
* `saved`: reuse the login of `TEETIME_TEST_EMAIL` saved by `npm run auth` (below).

Login is **email + one-time code**. `npm run auth` stores the session (cookie `authToken` + localStorage) and later
runs reuse it. Tests run in the installed **Google Chrome** app (`channel: "chrome"` in `playwright.config.ts`),
opened with a fresh profile each run, so your everyday Chrome window and its login are not used or changed.
To run the tests in a Chrome profile that stays signed in (e.g. to your Google account), set
`TEETIME_CHROME_PROFILE=.auth/chrome-profile` in `.env`, run `npm run chrome:login` once, sign in in that Chrome window
yourself and close it. Your everyday Chrome profile is still never used.

**One window per run:** before the tests start, `support/global-setup.ts` checks the saved login in the background
(no window). All tests then share **one** Chrome window (`sharedContext` in `tests/fixtures.ts`) that opens once and
closes at the end. Don't close or click that window during a headed run: closing it fails the running test, and
Playwright then opens a new window for the remaining tests. If staging has a
fixed test OTP for the test account, set `TEETIME_TEST_OTP` and it logs in by itself (CI).

## Run

**All commands in one place: [COMMANDS.md](COMMANDS.md)** (kept up to date by the `e2e-commands` skill).

| What | Command |
|---|---|
| The main run: every step in `tests/main`, in the order `tests/main.spec.ts` imports them (creating tests need `TEETIME_ALLOW_BOOKING_CREATION=true`) | `npm test` |
| The main run without the watching pauses, cursor and YopMail window | `npm run test:fast` |
| One step of the main run (e.g. the wallet cases) | `npm run test:wallet` (all in [COMMANDS.md](COMMANDS.md)) |
| Any one test by its number, visible | `npm run test:one -- TC21` |
| Visual runner | `npm run test:ui` |
| One case | `npx playwright test -g "TC2:" --headed` |
| Step-by-step debug | `npx playwright test -g "TC1:" --debug` |
| Visual runner (pick tests, watch live) | `npx playwright test --ui` |
| HTML report (screenshots, video, traces on failure) | `npm run report` |

## Notes

* **Bookings and charges:** `npm test` creates real bookings on dev (Stripe test mode: the saved test card or a
  Stripe published test card), wallet and gift card payments and a Core / Elite membership; the cancel steps cancel
  most of them again through the app. [COMMANDS.md](COMMANDS.md) lists, per command, which bookings stay.
  Confirmation and cancellation emails go to the test account.
* **Login expiry:** if a run says "Not authenticated" or the setup step asks for a code, run `npm run auth` again.
* **Free time:** the tests find the first free time themselves (today first, then up to 7 days ahead); a step with
  nothing free is skipped with a `blocked` annotation instead of failing.
* **Waiver:** the tests only tick the waiver checkbox; the waiver page is never opened.

## Safety

* Creating tests skip unless `TEETIME_ALLOW_BOOKING_CREATION=true` **and** both web and API hosts look like dev/staging/local.
* Payment: staging Stripe is in test mode (`pk_test_`). Use the test account's saved card (`TEETIME_PAYMENT_MODE=saved-card`) or a Stripe published test card (`test-card`).
* `retries: 0`, `workers: 1` — a retry after a slow successful POST would book twice.
* `TEETIME_CLEANUP=true` cancels created bookings through the app's own endpoint `PATCH /booking/cancel/:id?wantRefund=true`.

## Test cases

The 57 cases of `npm test`, numbered TC1–TC57 in the order they run, with what each checks: the **Single tests**
table in [COMMANDS.md](COMMANDS.md). They live in `tests/main`, one file per step, run in this order (the imports of `tests/main.spec.ts`):

| File | Cases |
|---|---|
| `card-flow.ts` (`@card-flow`) | TC1–6 login → create → reschedule → group size → extend → cancel (card) |
| `card-quick-shift.ts` (`@card-quick-shift`) | TC7–12 15 min earlier / later (card) |
| `card-refund.ts` (`@card-refund`) | TC13–18 cancel with 50% refund / no refund (card) |
| `card-switch-bay.ts` (`@card-switch-bay`) | TC19–24 extend to another bay, Switch to Trackman (card) |
| `wallet.ts` (`@wallet-credit`) | TC25–32 wallet: create → reschedule → group size → extend → cancel |
| `wallet-gift-card.ts` (`@wallet-gift-card`) | TC33 wallet + gift card, TC34 card + wallet + gift card (each booked and cancelled) |
| `gift-card.ts` (`@gift-card`) | TC35–40 gift card: create → reschedule → extend → cancel |
| `membership.ts` (`@membership`) | TC41–57 Core, Elite upgrade, cancel and keep membership |

## Code layout

| Where | What |
|---|---|
| `tests/main.spec.ts` | The main run: imports the step files in run order |
| `tests/main/*.ts` | One file per step (the test cases) |
| `tests/helper.ts` | Re-exports every helper; the step files import from here |
| `tests/helpers/` | The helpers by area: `suite` (setup, cleanup), `slots` (free-slot search, booking times), `payment` (wallet, member credit), `create`, `gift-card`, `change` (⋮ menu, reschedule, group size, extend), `cancel` (refund policy), `email` (YopMail window) |
| `tests/fixtures.ts`, `tests/money.ts` | The shared window and login; money and refund math |
| `support/booking-app.ts` | `BookingApp`, the page object of the booking site (calendar, Booking Details, checkout) |
| `support/booking-api.ts` | `BookingApi`, the backend calls BookingApp builds on (wallet, gift card, membership, a booking, cancel) |
| `support/booking-types.ts` | Shared shapes: a selected / created booking, the calendar, `BlockedError` |
| `support/env.ts` | The settings from `.env`, read once and frozen: a test never changes them for the next one |

Selectors use roles, labels, text, the app's data attributes (`data-screen` / `data-slot`) and its API data, not
styling classes, so a design change in booking-ui does not break them. One exception: the calendar shows that a booking
is the user's OWN only by its green outline, so that one class is read, from one place (`OWN_BOOKING_STYLE` in
`support/booking-app.ts`); a data attribute on the slot in booking-ui would replace it.

## Nightly run (CI)

`.github/workflows/nightly-e2e.yml` runs all 57 cases headless against dev every night at 13:00 UTC (3 AM in
Honolulu, when the day's credit hours and refund windows are still ahead), and on demand (Actions → Nightly E2E → Run
workflow). A run without a window is a fast run by itself. It needs these in the GitHub repository (Settings → Secrets
and variables → Actions):

| Kind | Name | Value |
|---|---|---|
| Secret | `TEETIME_TEST_OTP` | The dev backend's fixed test code |
| Variable | `TEETIME_STRIPE_TEST_CARD`, `_EXP`, `_CVC`, `_ZIP` | Stripe's published test card |
| Secret (optional) | `TEETIME_GIFT_CARD_CODE`, `TEETIME_SMALL_GIFT_CARD_CODE`, `TEETIME_REDEEM_GIFT_CODE` | Three gift cards (see "Gift cards"); empty or used up -> those steps are skipped |
| Variable (optional) | `TEETIME_BASE_URL`, `TEETIME_API_URL` | Other dev hosts (default: the dev site and API) |

It books and pays on dev like `npm test` and cancels what it books (`TEETIME_CLEANUP=true`). The test user's email is
kept between nights (cache), so the same user logs in every night. The HTML report and the traces are an artifact of
each run (14 days). Gift cards are used up over the nights (redeemed, or 10% kept per cancellation): top them up in
admin, or the gift card steps are skipped.

## How the app behaves (from code analysis)

* **Stack**: Vite + React SPA, react-router, react-query, redux-persist, Radix/shadcn UI, Stripe Elements, socket.io.
  API: `https://dev-booking-api.teetimeindoorgolf.com/v1`. No `data-testid`s; the grid has `data-slot` / `data-screen`.
* **Location**: header button `title="Change Location"` → `/location` → card → "Location Change" dialog → **Change Location**.
  This saves `selectedLocationId` on the user's account (PATCH user), so it persists across sessions.
* **Calendar**: 15-minute slots; 8:00 PM = slot 80, last slot of 8–9 PM = 83. Click the first slot, then the last one.
  Non-admin users can only go up to `maxAccessDays` (default 1 → today/tomorrow).
* **Header after selection** shows only `Book Now $price` + `Cancel`; bay/date/time are verified in the grid label and the modal.
* **Booking modal** ("Booking Details"): location, `8:00 PM - 9:00 PM (Evening)`, Today/Tomorrow, bay select, start/end selects,
  group-size buttons 1–5 (required), pricing, saved card / Stripe card fields, waiver checkbox (required), **Confirm**.
* **Waiver**: the "Waiver" link inside the checkbox label opens `https://teetimeindoorgolf.com/waiver`
  — desktop: `window.open(..., "_blank", "noopener,noreferrer")` (new tab); mobile (<768px): full-screen iframe dialog.
  The page is static legal text (no form). Acceptance = the modal checkbox only; it is **not sent to the backend**.
* **Confirm**: `POST /booking/:locationId/:bayId` (charges the card / wallet in the same call) → on `success`
  navigates to `/book-slot/success?bookingId=…&returnTo=/book-now`.
* **Confirmation screen** (`BookingCheckout`): loads `GET /booking/:id`; shows "Booking Confirmed", email, date, `hh:mm A - hh:mm A`,
  location, bay, "N Persons"/"1 Player", Add to Google Calendar, **View My Booking**. It is a post-payment confirmation, not a checkout form.
* **View My Booking** → `navigate(returnTo)` = `/book-now` (calendar). The calendar's date isn't preserved, so tests move to the booking date.
