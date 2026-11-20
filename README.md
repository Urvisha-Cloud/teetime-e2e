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
| Everything (creating tests need `TEETIME_ALLOW_BOOKING_CREATION=true`) | `npm test` |
| Watch it run in a visible browser | `npm run test:headed` |
| Booking journey only (signup -> book -> confirmation -> calendar), visible | `npm run test:create` |
| All negative cases (TC15–25), visible | `npm run test:negative` |
| Payment errors only (TC18–25), visible | `npm run test:payment` |
| No group size case (TC25), visible | `npm run test:no-group-size` |
| Any one test by name, visible | `npm run test:one -- "TC21"` |
| Visual runner | `npm run test:ui` |
| Read-only tests only (never creates a booking) | `npm run test:readonly` |
| Only the test that creates a booking (TC11–14, one booking) | `npm run test:booking` |
| Group sizes 1–5 (no booking) | `npm run test:group-sizes` |
| One group size | `npx playwright test -g "group size 3" --headed` |
| One case | `npx playwright test -g "TC11" --headed` |
| Step-by-step debug | `npx playwright test -g "TC1:" --debug` |
| Visual runner (pick tests, watch live) | `npx playwright test --ui` |
| HTML report (screenshots, video, traces on failure) | `npm run report` |

## Notes

* **Bookings and charges:** a full `npm test` creates exactly **one** booking (TC11, group size 3), charged to the
  saved card in Stripe test mode. Every other test is read-only or answers the create call with a simulated
  response. With `TEETIME_CLEANUP=true` the booking is cancelled after TC14 (dev applies its normal 10% cancellation fee to the test refund). Confirmation and
  cancellation emails go to the test account.
* **Login expiry:** if a run says "Not authenticated" or the setup step asks for a code, run `npm run auth` again.
* **Full slot:** if 8–9 PM is booked in every bay, that test is skipped with a `blocked` annotation instead of failing.
* **Known app issue (TC17):** double-clicking Confirm sends two create requests. On the real API the database rejects
  the second ("Exclusion constraint error") and the error toast appears on the confirmation screen. TC17 now answers
  both requests itself (nothing is booked) and is marked as an expected failure (`test.fail`), so the run keeps one
  window and reports it as a known bug. When the booking site disables Confirm after the first click, TC17 is
  reported as "unexpectedly passed": then remove the `test.fail(...)` line.
* **Waiver:** the tests only tick the waiver checkbox; the waiver page is never opened.
* **Scheduled runs:** on Windows use Task Scheduler (run `npm test` with "Start in" set to this folder); on Mac/Linux
  a cron job such as `0 9 * * * cd /path/to/teetime-e2e && npm test`. The saved login eventually expires, so a
  scheduled run will need `npm run auth` again from time to time.

## Safety

* Creating tests skip unless `TEETIME_ALLOW_BOOKING_CREATION=true` **and** both web and API hosts look like dev/staging/local.
* Read-only tests (TC1–7, TC10, TC15) route-abort any `POST /booking/:locationId/:bayId` and assert none was sent.
* TC16 answers the create call with a simulated failure — nothing reaches staging.
* Payment: staging Stripe is in test mode (`pk_test_`). Use the test account's saved card (`TEETIME_PAYMENT_MODE=saved-card`) or a Stripe published test card (`test-card`).
* `retries: 0`, `workers: 1` — a retry after a slow successful POST would book twice.
* `TEETIME_CLEANUP=true` cancels created bookings through the app's own endpoint `PATCH /booking/cancel/:id?wantRefund=true`.
* If 8:00–9:00 PM is taken in every bay (or the date isn't allowed), the test is **skipped with a `blocked` annotation**. It never switches to another time.

## Test cases

| # | File | Creates booking |
|---|---|---|
| TC1–5 group size 1..5 can be selected, waiver ticked, Confirm enabled (not pressed) | `group-sizes.spec.ts` | no |
| TC6 header: location / date / selected time | `booking-ui.spec.ts` | no |
| TC7 Book Now opens the correct modal | `booking-ui.spec.ts` | no |
| TC10 Group-size + waiver validation | `booking-ui.spec.ts` | no |
| TC11–14 Confirm → confirmation screen → View My Booking → visible on calendar | `booking-create.spec.ts` | yes (1 shared) |
| TC15 Unavailable (past / booked) slots can't be selected | `booking-negative.spec.ts` | no |
| TC16 Error handling when booking creation fails (500 / success:false) | `booking-negative.spec.ts` | no (mocked) |
| TC17 Double-click Confirm sends one create request (simulated success, nothing reaches staging) | `booking-negative.spec.ts` | no (mocked) |
| TC18 Invalid card number rejected before any booking request | `payment-negative.spec.ts` | no |
| TC19 Missing ZIP code rejected before any booking request | `payment-negative.spec.ts` | no |
| TC25 No group size selected (waiver + valid card filled): blocked with the group-size error before any booking request | `payment-negative.spec.ts` | no |
| TC27–31 Reschedule: book → ⋮ → Manage your booking → Reschedule → Start Rescheduling → new time → Reschedule → Confirm Changes → Reschedule details (waiver) → Confirm → Booking Confirmed → View My Booking → calendar shows the new time | `booking-reschedule.spec.ts` | yes (1) |
| TC32–34 Update group size (same booking): ⋮ → Manage your booking → Update Group Size → Select Group Size → Add players → Reschedule details (waiver) → Confirm → Booking Confirmed → View My Booking → calendar shows the new group size | `booking-reschedule.spec.ts` | (TC27's booking) |
| TC48–53 Quick shift: ⋮ → 15 min earlier / 15 min later → Reschedule booking (Current / New) → Confirm changes → Booking Confirmed (10 s) → View My Booking → calendar | `booking-reschedule.spec.ts` | yes (2) |
| TC35–37 Cancel: book → ⋮ → Manage your booking → Cancel Booking → Confirm Cancellation → "Booking cancelled" → calendar shows the slots free | `booking-cancel.spec.ts` | yes (1, cancelled in the test) |
| TC38–41 Extend: book → ⋮ → Manage your booking → Extend Booking → +30 min → Continue → Extend details (waiver, pay) → Confirm → Booking Confirmed → View My Booking → calendar shows the new end time | `booking-extend.spec.ts` | yes (1) |
| TC54–57 Extend popup controls: + / −, presets, maximum (past midnight), slider → +45 min → Extend details → Booking Confirmed → calendar → My Booking | `booking-extend.spec.ts` | yes (1) |
| TC20–24 Stripe test cards declined on charge (insufficient funds, declined, expired, incorrect CVC, processing error): error toast, user stays in the modal, no booking left | `payment-negative.spec.ts` | no (sends a real create request; the backend deletes the pending booking) |

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
