# TeeTime E2E — commands

Every command runs from the `teetime-e2e` folder (`cd E:\teetime-e2e`).
Keep this file in sync with `package.json` and the tests: see `.claude/skills/e2e-commands/SKILL.md`.

**Every command opens a visible Chrome window** so you can watch the test. (Only the daily 9 AM scheduled run,
`run-readonly.cmd`, runs in the background.)

*Real booking*: whether the run leaves a real booking on dev (it is cancelled at the end when `TEETIME_CLEANUP=true`).
"Request only" = a real create request is sent, but the backend deletes the booking again (declined card).

## Setup (once)

| Command | What it does |
|---|---|
| `npm ci` | Install the exact packages from `package-lock.json` (also fixes "playwright is not recognized") |
| `npx playwright install chromium` | Install Playwright's browser files (tests themselves use your installed Google Chrome) |
| `npm run auth` | Only for `TEETIME_AUTH_MODE=saved`: log in once as `TEETIME_TEST_EMAIL` and type the emailed code |
| `npm run typecheck` | Check the test code compiles (TypeScript) |

## Run groups of tests

| Command | What it runs | Real booking |
|---|---|---|
| `npm test` | **The booking flow, step by step on ONE booking** (TC42–47): login (new user signs up if none is saved or it was deleted, else the saved user logs in) → create → reschedule (same group size) → update group size → extend → cancel. The extend step (TC46) uses every extend control on that same booking: + / −, each preset, the maximum, the slider. Then the two quick-shift scenarios (TC48–53). Chrome closes and the command ends when all steps are done | 3 (TC43, TC48, TC51; all cancelled) |
| `npm run test:all` | Everything (45 tests) | 5 (TC11, TC27, TC35, TC38, TC43) + request only (TC20–24) |
| `npm run test:headed` | Same as `npm run test:all` | 5 (TC11, TC27, TC35, TC38, TC43) + request only (TC20–24) |
| `npm run test:readonly` | Everything except `@creates-booking` | No |
| `npm run test:booking` | Only `@creates-booking`: journey TC11–14, declined cards TC20–24, reschedule + group size TC27–34, cancel TC35–37, extend TC38–41, full flow TC42–47 | 5 (TC11, TC27, TC35, TC38, TC43) + request only |
| `npm run test:journey` | Booking journey TC11–14: sign up → book → confirmation screen → View My Booking → calendar | 1 (TC11) |
| `npm run test:flow` | **Full flow on ONE booking, step by step** TC42–47: login → create (8–9 PM, 1 player) → reschedule (9–11 PM, same group size) → update group size (5) → extend (+30 min, to 11:30 PM) → cancel → calendar free | 1 (TC43, cancelled by TC47) |
| `npm run test:quick-shift` | Quick shift TC48–53, one booking each: ⋮ → **15 min earlier** / **15 min later** → "Reschedule booking" shows Current and New time → Confirm changes → Booking Confirmed with the new time → View My Booking → calendar → My Booking page shows the new time | 2 (TC48, TC51; cancelled afterwards) |
| `npm run test:extend-controls` | Extend popup controls TC54–57 on one booking: "+" / "−", presets +30 min / +1 hr / +2 hr / +3 hr, slider drag — label, slider and "Ends …" always agree, min 15 min / max 3 hr ("Ends 12:00 AM" past midnight) → +45 min → Continue → Extend details → Booking Confirmed → calendar → My Booking | 1 (TC54; cancelled afterwards) |
| `npm run test:reschedule` | Reschedule + group size TC27–34: book → ⋮ → Reschedule → new time → Confirm Changes → Reschedule details → Booking Confirmed → calendar, then ⋮ → Update Group Size → Add players → Reschedule details → Booking Confirmed → calendar | 1 (TC27) |
| `npm run test:cancel` | Cancel TC35–37: book → ⋮ → Manage your booking → Cancel Booking → Confirm Cancellation → calendar shows it gone | 1 (TC35, cancelled by TC36) |
| `npm run test:extend` | Extend TC38–41: book → ⋮ → Manage your booking → Extend Booking → `TEETIME_EXTEND_BY` (+30 min) → Continue → Extend details (waiver, pay) → Confirm → Booking Confirmed → View My Booking → calendar shows the longer booking | 1 (TC38) |
| `npm run test:group-sizes` | Group sizes 1–5 (TC1–5) | No |
| `npm run test:negative` | All negative cases TC15–25 (12 tests) | Request only (TC20–24) |
| `npm run test:payment` | Payment errors TC18–25 | Request only (TC20–24) |
| `npm run test:no-group-size` | TC25 only | No |
| `npm run test:one -- "TC21"` | Any one test by its number or a word from its title | Depends on the test |
| `npm run test:ui` | Visual runner: pick tests in a window and watch them run | Depends on what you run |

**Reading speed (`npm test`):** the flow pauses about 1 s on every modal (manage menu, How to reschedule, the selected time, Reschedule booking, the details with a slow scroll through the price, extend time, group size, cancel refund) so you can follow it. Change it with `TEETIME_READ_MS` in `.env` (e.g. `3000` to read longer; `0` = full speed).

Add options after `--`, e.g. `npm run test:payment -- --debug`. Without npm: `npx playwright test <file> --headed`
(not `npm playwright …`, which is not a valid command). Leaving out `--headed` in an `npx` command runs it in the
background without a window.

## Single tests

Run any of these with `npm run test:one -- "<TC>"`.

| TC | File | What it checks | Real booking |
|---|---|---|---|
| TC1–5 | `group-sizes.spec.ts` | Group size 1/2/3/4/5 can be selected, waiver ticked, Confirm enabled (not pressed) | No |
| TC6 | `booking-ui.spec.ts` | Header shows the selected location, date and time | No |
| TC7 | `booking-ui.spec.ts` | Book Now opens Booking Details with the right details | No |
| TC10 | `booking-ui.spec.ts` | Confirm blocked until a group size is chosen and the waiver is ticked | No |
| TC11 | `booking-journey.spec.ts` | Confirm creates the booking (the only real booking per run) | Yes |
| TC12 | `booking-journey.spec.ts` | "Booking Confirmed" screen shows the booking details | (TC11's) |
| TC13 | `booking-journey.spec.ts` | View My Booking returns to the calendar | (TC11's) |
| TC14 | `booking-journey.spec.ts` | The booking is outlined on the calendar, then Chrome closes | (TC11's) |
| TC15 | `booking-negative.spec.ts` | Past / booked time slots can't be selected | No |
| TC16 | `booking-negative.spec.ts` | Booking failure (simulated HTTP 500 / success:false) shows an error | No (mocked) |
| TC17 | `booking-negative.spec.ts` | Double-click Confirm sends one request — known bug, expected to fail | No (mocked) |
| TC18 | `payment-negative.spec.ts` | Invalid card number rejected before any booking request | No |
| TC19 | `payment-negative.spec.ts` | Missing ZIP code rejected before any booking request | No |
| TC20 | `payment-negative.spec.ts` | Insufficient funds card (`4000 0000 0000 9995`) → error, no booking left | Request only |
| TC21 | `payment-negative.spec.ts` | Generic decline card (`4000 0000 0000 0002`) → error, no booking left | Request only |
| TC22 | `payment-negative.spec.ts` | Expired card (`4000 0000 0000 0069`) → error, no booking left | Request only |
| TC23 | `payment-negative.spec.ts` | Incorrect CVC card (`4000 0000 0000 0127`) → error, no booking left | Request only |
| TC24 | `payment-negative.spec.ts` | Processing error card (`4000 0000 0000 0119`) → error, no booking left | Request only |
| TC25 | `payment-negative.spec.ts` | No group size selected (waiver + valid card filled) → blocked, no booking request | No |
| TC27 | `booking-reschedule.spec.ts` | Book the original slot (`TEETIME_SLOT_START–END`, 8–9 PM) and see it on the calendar | Yes |
| TC28 | `booking-reschedule.spec.ts` | Booking ⋮ → "Manage your booking" → Reschedule → "How to reschedule" → Start Rescheduling | (TC27's) |
| TC29 | `booking-reschedule.spec.ts` | Select the new time (`TEETIME_RESCHEDULE_START–END`, 9–11 PM) → header Reschedule → "Reschedule booking" → Confirm Changes | (TC27's) |
| TC30 | `booking-reschedule.spec.ts` | "Reschedule details": group size `TEETIME_RESCHEDULE_GROUP_SIZE` (4), waiver, pay difference if any → Confirm → Booking Confirmed with the new time | (TC27's) |
| TC31 | `booking-reschedule.spec.ts` | View My Booking → calendar shows the booking at the new time, not the old one | (TC27's) |
| TC32 | `booking-reschedule.spec.ts` | ⋮ → "Manage your booking" → Update Group Size → "Update group size" (smaller sizes disabled, Add players disabled until a larger size is picked) → `TEETIME_GROUP_SIZE_UPDATE` (5) → Add players | (TC27's) |
| TC33 | `booking-reschedule.spec.ts` | "Reschedule details" with the new group size → waiver → pay difference if any → Confirm → Booking Confirmed with the new number of persons | (TC27's) |
| TC34 | `booking-reschedule.spec.ts` | View My Booking → calendar shows the booking with the new group size | (TC27's) |
| TC35 | `booking-cancel.spec.ts` | Book a slot to cancel (`TEETIME_SLOT_START–END`, 8–9 PM) and see it on the calendar | Yes |
| TC36 | `booking-cancel.spec.ts` | ⋮ → "Manage your booking" → Cancel Booking → "Cancel Booking" (refund policy) → Confirm Cancellation → "Booking cancelled" | Cancels TC35's |
| TC37 | `booking-cancel.spec.ts` | Calendar no longer shows the cancelled booking: not active for the user, its slots free again | (TC35's) |
| TC38 | `booking-extend.spec.ts` | Book the slot to extend (8–9 PM; the time after it must be free) and see it on the calendar | Yes |
| TC39 | `booking-extend.spec.ts` | ⋮ → "Manage your booking" → Extend Booking → "Extend Booking" popup → `TEETIME_EXTEND_BY` (+30 min) → "Ends 9:30 PM" → Continue | (TC38's) |
| TC40 | `booking-extend.spec.ts` | "Extend details": pay for the extra time if "You pay" > $0, waiver → Confirm → Booking Confirmed with the new end time | (TC38's) |
| TC41 | `booking-extend.spec.ts` | View My Booking → calendar shows the booking up to the new end time | (TC38's) |
| TC42 | `booking-flow.spec.ts` | Flow step 1 — login: no saved user (or deleted) → signs up a new `teetime-e2e-…@yopmail.com` user; saved user exists → logs in. Reports which one happened; calendar loads signed in | No |
| TC43 | `booking-flow.spec.ts` | Flow step 2 — create: book 8–9 PM (1 player; 9:00–11:30 PM must also be free in that bay) → Booking Confirmed → calendar | Yes |
| TC44 | `booking-flow.spec.ts` | Flow step 3 — reschedule: ⋮ → Manage your booking → Reschedule → Start rescheduling → 9–11 PM → Confirm changes → Reschedule details (group size unchanged) → Booking Confirmed → calendar | (TC43's) |
| TC45 | `booking-flow.spec.ts` | Flow step 4 — update group size: ⋮ → Update Group Size → 5 → Add players → Reschedule details → Booking Confirmed → calendar | (TC43's) |
| TC46 | `booking-flow.spec.ts` | Flow step 5 — extend: ⋮ → Extend Booking → every control on the same booking, label / slider / Ends always in sync: starts +15 min (− disabled) → + to +1 hr → − → each preset that fits → + to the maximum (+ disabled; past midnight "Ends Sun 12:30 AM") → back to +15 min → slider dragged to +30 min → Continue → Extend details → Booking Confirmed (ends 11:30 PM) → calendar | (TC43's) |
| TC47 | `booking-flow.spec.ts` | Flow step 6 — cancel: ⋮ → Cancel booking → Confirm cancellation → "Booking cancelled" → slots free on the calendar | Cancels TC43's |
| TC48 | `booking-quick-shift.spec.ts` | 15 min earlier — book 8–9 PM (7:45–8:00 PM must also be free in that bay) | Yes |
| TC49 | `booking-quick-shift.spec.ts` | ⋮ → 15 min earlier → Reschedule booking: Current 8:00–9:00 PM, New 7:45–8:45 PM → Confirm changes → Booking Confirmed 7:45–8:45 PM | (TC48's) |
| TC50 | `booking-quick-shift.spec.ts` | View My Booking → calendar at 7:45–8:45 PM (8:45–9:00 freed) → My Booking page shows 07:45 PM | (TC48's) |
| TC51 | `booking-quick-shift.spec.ts` | 15 min later — book 8–9 PM (9:00–9:15 PM must also be free in that bay) | Yes |
| TC52 | `booking-quick-shift.spec.ts` | ⋮ → 15 min later → Reschedule booking: Current 8:00–9:00 PM, New 8:15–9:15 PM → Confirm changes → Booking Confirmed 8:15–9:15 PM | (TC51's) |
| TC53 | `booking-quick-shift.spec.ts` | View My Booking → calendar at 8:15–9:15 PM (8:00–8:15 freed) → My Booking page shows 08:15 PM | (TC51's) |
| TC54 | `booking-extend-controls.spec.ts` | Book 8–9 PM with the 3 hours after it free in that bay (the popup maximum) | Yes |
| TC55 | `booking-extend-controls.spec.ts` | Extend popup: starts +15 min (− disabled) → + ×3 = +1 hr → − = +45 min → each preset → +3 hr = max (+ disabled, Ends 12:00 AM) → − to the minimum → drag slider to +45 min; label, slider and Ends always match → Continue | (TC54's) |
| TC56 | `booking-extend-controls.spec.ts` | Extend details (new range) → waiver → Confirm → PATCH /booking/extend → Booking Confirmed ending 9:45 PM | (TC54's) |
| TC57 | `booking-extend-controls.spec.ts` | View My Booking → calendar up to 9:45 PM → My Booking page shows 09:45 PM | (TC54's) |

## Reports and debugging

| Command | What it does |
|---|---|
| `npm run report` | Open the last HTML report (screenshots and traces of failures) |
| `npx playwright show-trace test-results/<folder>/trace.zip` | Step through one failed test |
| `npx playwright test -g "TC1:" --debug` | Run one test step by step in the Playwright inspector |

## Good to know

* Stop a running test with **Ctrl+C** in the terminal. Don't close or click the test Chrome window during a run.
* Login: `TEETIME_AUTH_MODE=signup` (default) reuses one test user (`teetime-e2e-<time>@yopmail.com`, remembered in
  `.auth/e2e-user.json`): the first run signs it up, later runs log in with email + code `1111`; a deleted user is signed
  up again, a blocked one replaced. Delete `.auth/e2e-user.json` for a brand-new user; `saved` reuses the login from `npm run auth`. Settings live in `.env`.
