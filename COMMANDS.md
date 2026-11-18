# TeeTime E2E — commands

Every command runs from the `teetime-e2e` folder (`cd E:\teetime-e2e`).
Keep this file in sync with `package.json` and the tests: see `.claude/skills/e2e-commands/SKILL.md`.

**Every command opens the browser of this computer — Google Chrome on Windows, Safari (WebKit) on a Mac** — in a visible window (`TEETIME_BROWSER=chrome|safari|both` in `.env` to choose) so you can watch the test. (Only the daily 9 AM scheduled run,
`run-readonly.cmd`, runs in the background.)

*Real booking*: whether the run leaves a real booking on dev (it is cancelled at the end when `TEETIME_CLEANUP=true`).
"Request only" = a real create request is sent, but the backend deletes the booking again (declined card).

## Setup (once)

| Command | What it does |
|---|---|
| `npm ci` | Install the exact packages from `package-lock.json` (also fixes "playwright is not recognized") |
| `npx playwright install chromium` | Install Playwright's browser files (tests themselves use your installed Google Chrome) |
| `npx playwright install webkit` | Install Safari's engine (WebKit) for the `desktop-safari` project |
| `npm run auth` | Only for `TEETIME_AUTH_MODE=saved`: log in once as `TEETIME_TEST_EMAIL` and type the emailed code |
| `npm run typecheck` | Check the test code compiles (TypeScript) |

## Run groups of tests

| Command | What it runs | Real booking |
|---|---|---|
| `npm test` | **The booking flow on ONE booking** TC42–47: login → create → reschedule → group size → extend → **cancel: the refund policy is checked and applied** (90%). Then the two quick-shift scenarios TC48–53. **Last**, two more cancel cases (`refund-cancel.spec.ts`): a booking starting 1–4 h from now → cancel → **50% refund** (TC84–86), and one starting within 1 h → cancel → **no refund** (TC87–89); both check the popup, confirm the cancellation straight away, then check the refund the backend applied and that the booking is gone (each skips itself when no such time is free today). Chrome closes and the command ends when all steps are done | 5 (TC43, TC84, TC87 cancelled by their own tests; TC48, TC51 kept) |
| `npm run test:chrome` | Same as `npm test`, Google Chrome only | Same as `npm test` |
| `npm run test:safari` | Same as `npm test`, Safari (WebKit) only | Same as `npm test` |
| `npm run test:all` | Everything (45 tests) | 5 (TC11, TC27, TC35, TC38, TC43) + request only (TC20–24) |
| `npm run test:headed` | Same as `npm run test:all` | 5 (TC11, TC27, TC35, TC38, TC43) + request only (TC20–24) |
| `npm run test:readonly` | Everything except `@creates-booking` | No |
| `npm run test:booking` | Only `@creates-booking`: journey TC11–14, declined cards TC20–24, reschedule + group size TC27–34, quick shift TC48–53, cancel TC35–37, extend TC38–41 + TC54–57, full flow TC42–47 | 5 (TC11, TC27, TC35, TC38, TC43) + request only |
| `npm run test:create` | Booking journey TC11–14: sign up → book → confirmation screen → View My Booking → calendar | 1 (TC11) |
| `npm run test:flow` | **Full flow on ONE booking, step by step** TC42–47: login → create (8–9 PM, 1 player) → reschedule (9–11 PM, same group size) → update group size (5) → extend (+30 min, to 11:30 PM) → cancel → calendar free | 1 (TC43, cancelled by TC47) |
| `npm run test:reschedule-rules` | Reschedule rules TC62–80 (customer side), a fresh booking per group: only once · leave without changing (Back, X, Cancel, closed details, other bays disabled, shorter time refused, group size max) · to another date · within 4 hours · conflicts with another booking · API error + double-click · declined card | 6–7 (one per group, B extra in conflicts) |
| `npm run test:reschedule` | Every reschedule case: reschedule + group size TC27–34 (book → ⋮ → Reschedule → new time → Confirm Changes → Reschedule details → Booking Confirmed → calendar, then ⋮ → Update Group Size → Add players → Reschedule details → Booking Confirmed → calendar), then quick shift TC48–53, one booking each (⋮ → **15 min earlier** / **15 min later** → "Reschedule booking" shows Current and New time → Confirm changes → Booking Confirmed with the new time (waits 10 s) → View My Booking → calendar shows the new time) | 3 (TC27, TC48, TC51; cancelled afterwards) |
| `npm run test:cancel` | Cancel TC35–37 and the refund cases TC81–89 (90% / 50% / no refund: policy list, refund amount, cancel, refund applied) | 4 (TC35, TC81, TC84, TC87; each cancelled by its own test) |
| `npm run test:extend` | Every extend case, one booking each: TC38–41 book → ⋮ → Manage your booking → Extend Booking → `TEETIME_EXTEND_BY` (+30 min) → Continue → Extend details (waiver, pay) → Confirm → Booking Confirmed → View My Booking → calendar shows the longer booking; TC54–57 popup controls "+" / "−", presets +30 min / +1 hr / +2 hr / +3 hr, slider drag — label, slider and "Ends …" always agree, min 15 min / max 3 hr ("Ends 12:00 AM" past midnight) → +45 min → Continue → Extend details → Booking Confirmed → calendar → My Booking (+ TC58–61: time after taken → book a new session instead) | 2 (TC38, TC54; cancelled afterwards) |
| `npm run test:group-sizes` | Group sizes 1–5 (TC1–5) | No |
| `npm run test:negative` | All negative cases TC15–25 (12 tests) | Request only (TC20–24) |
| `npm run test:payment` | Payment errors TC18–25 | Request only (TC20–24) |
| `npm run test:no-group-size` | TC25 only | No |
| `npm run test:one -- "TC21"` | Any one test by its number or a word from its title | Depends on the test |
| `npm run test:ui` | Visual runner: pick tests in a window and watch them run | Depends on what you run |

**Reading speed (`npm test`):** the flow pauses about 1 s on every modal (manage menu, How to reschedule, the selected time, Reschedule booking, the details with a slow scroll through the price, extend time, group size, cancel refund) so you can follow it. Change it with `TEETIME_READ_MS` in `.env` (e.g. `3000` to read longer; `0` = full speed).

**Booking time:** not configured — the tests find it. Every test that books starts with **today**: the earliest time at least 4.5 h from now (`TEETIME_MIN_LEAD_MINUTES`, default 270 — the app blocks rescheduling within 4 h of the start) where one bay is free for 1 hr plus whatever that test needs afterwards in the same bay (reschedule: the 2 hr right after; extend: the time after; 15 min earlier / later: the 15 min before / after). Nothing fits today → the calendar's › arrow and the next day, up to 7 days. **If the booking cannot be created** (slot taken meanwhile, refused), anything that attempt created for the test user is cancelled, the calendar is reloaded and another free slot is tried — 3 attempts, then the test fails with the last error. Before a 15-min shift the test re-checks that the 15 min are still free; if not, it cancels its booking and books another slot (3 tries). Bookings are **kept** after a test (`TEETIME_CLEANUP=false`): the next test or run simply finds another free slot. Only the cancel tests (e.g. the flow's TC47) cancel a booking, through the app. Set `TEETIME_CLEANUP=true` to cancel every test booking at the end instead. Other people's bookings are never touched. The terminal and the report show the time used.

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
| TC11 | `booking-create.spec.ts` | Confirm creates the booking (the only real booking per run) | Yes |
| TC12 | `booking-create.spec.ts` | "Booking Confirmed" screen shows the booking details | (TC11's) |
| TC13 | `booking-create.spec.ts` | View My Booking returns to the calendar | (TC11's) |
| TC14 | `booking-create.spec.ts` | The booking is outlined on the calendar, then Chrome closes | (TC11's) |
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
| TC27 | `booking-reschedule.spec.ts` | Book the original slot (first free 1-hour time) and see it on the calendar | Yes |
| TC28 | `booking-reschedule.spec.ts` | Booking ⋮ → "Manage your booking" → Reschedule → "How to reschedule" → Start Rescheduling | (TC27's) |
| TC29 | `booking-reschedule.spec.ts` | Select the new time (the 2 hours right after the booking) → header Reschedule → "Reschedule booking" → Confirm Changes | (TC27's) |
| TC30 | `booking-reschedule.spec.ts` | "Reschedule details": group size `TEETIME_RESCHEDULE_GROUP_SIZE` (4), waiver, pay difference if any → Confirm → Booking Confirmed with the new time | (TC27's) |
| TC31 | `booking-reschedule.spec.ts` | View My Booking → calendar shows the booking at the new time, not the old one | (TC27's) |
| TC32 | `booking-reschedule.spec.ts` | ⋮ → "Manage your booking" → Update Group Size → "Update group size" (smaller sizes disabled, Add players disabled until a larger size is picked) → `TEETIME_GROUP_SIZE_UPDATE` (5) → Add players | (TC27's) |
| TC33 | `booking-reschedule.spec.ts` | "Reschedule details" with the new group size → waiver → pay difference if any → Confirm → Booking Confirmed with the new number of persons | (TC27's) |
| TC34 | `booking-reschedule.spec.ts` | View My Booking → calendar shows the booking with the new group size | (TC27's) |
| TC35 | `booking-cancel.spec.ts` | Book a slot to cancel (first free 1-hour time) and see it on the calendar | Yes |
| TC36 | `booking-cancel.spec.ts` | ⋮ → "Manage your booking" → Cancel Booking → "Cancel Booking" (refund policy) → Confirm Cancellation → "Booking cancelled" | Cancels TC35's |
| TC37 | `booking-cancel.spec.ts` | Calendar no longer shows the cancelled booking: not active for the user, its slots free again | (TC35's) |
| TC81 | `refund-cancel.spec.ts` | Cancel 90% — book a slot more than 4 h ahead | Yes |
| TC82 | `refund-cancel.spec.ts` | Cancel popup: "How refunds work" shows the 3 tiers; Total refund (90%) = paid × 90%, Card line, 10% fee note → Confirm cancellation straight away → the backend applied refund = paid × 90%, fee = the rest, "partial refund (10% fee applied)" | Cancels TC81's |
| TC83 | `refund-cancel.spec.ts` | The cancelled booking is gone from the calendar (not active, slots free) | (TC81's) |
| TC84 | `refund-cancel.spec.ts` | Cancel 50% — book today, starting 80 min–3 h 40 min from now (skipped if none free) | Yes |
| TC85 | `refund-cancel.spec.ts` | Cancel popup: tiers + Total refund (50%) = paid × 50% → Confirm cancellation → applied refund = paid × 50%, "partial refund (50% fee applied)" | Cancels TC84's |
| TC86 | `refund-cancel.spec.ts` | The cancelled booking is gone from the calendar | (TC84's) |
| TC87 | `refund-cancel.spec.ts` | Cancel no refund — book today, starting 15–45 min from now (skipped if none free) | Yes |
| TC88 | `refund-cancel.spec.ts` | Cancel popup: tiers + "non-refundable" notice, no Total refund → Confirm cancellation → applied refund $0.00 | Cancels TC87's |
| TC89 | `refund-cancel.spec.ts` | The cancelled booking is gone from the calendar | (TC87's) |
| TC38 | `booking-extend.spec.ts` | Book the slot to extend (8–9 PM; the time after it must be free) and see it on the calendar | Yes |
| TC39 | `booking-extend.spec.ts` | ⋮ → "Manage your booking" → Extend Booking → "Extend Booking" popup → `TEETIME_EXTEND_BY` (+30 min) → "Ends 9:30 PM" → Continue | (TC38's) |
| TC40 | `booking-extend.spec.ts` | "Extend details": pay for the extra time if "You pay" > $0, waiver → Confirm → Booking Confirmed with the new end time | (TC38's) |
| TC41 | `booking-extend.spec.ts` | View My Booking → calendar shows the booking up to the new end time | (TC38's) |
| TC42 | `booking-flow.spec.ts` | Flow step 1 — login: no saved user (or deleted) → signs up a new `teetime-e2e-…@yopmail.com` user; saved user exists → logs in. Reports which one happened; calendar loads signed in | No |
| TC43 | `booking-flow.spec.ts` | Flow step 2 — create: book 8–9 PM (1 player; 9:00–11:30 PM must also be free in that bay) → Booking Confirmed → calendar | Yes |
| TC44 | `booking-flow.spec.ts` | Flow step 3 — reschedule: ⋮ → Manage your booking → Reschedule → Start rescheduling → 9–11 PM → Confirm changes → Reschedule details (group size unchanged) → Booking Confirmed → calendar | (TC43's) |
| TC45 | `booking-flow.spec.ts` | Flow step 4 — update group size: ⋮ → Update Group Size → 5 → Add players → Reschedule details → Booking Confirmed → calendar | (TC43's) |
| TC46 | `booking-flow.spec.ts` | Flow step 5 — extend: ⋮ → Extend Booking → every control on the same booking, label / slider / Ends always in sync: starts +15 min (− disabled) → + to +1 hr → − → each preset that fits → + to the maximum (+ disabled; past midnight "Ends Sun 12:30 AM") → back to +15 min → slider dragged to +30 min → Continue → Extend details → Booking Confirmed (ends 11:30 PM) → calendar | (TC43's) |
| TC47 | `booking-flow.spec.ts` | Flow step 6 — cancel: ⋮ → Cancel booking → Confirm cancellation → refund shown per policy (90%) and applied by the API → "Booking cancelled" → slots free on the calendar | Cancels TC43's |
| TC48 | `booking-reschedule.spec.ts` | 15 min earlier — book 8–9 PM (7:45–8:00 PM must also be free in that bay) | Yes |
| TC49 | `booking-reschedule.spec.ts` | ⋮ → 15 min earlier → Reschedule booking: Current 8:00–9:00 PM, New 7:45–8:45 PM → Confirm changes → Booking Confirmed 7:45–8:45 PM (stays 10 s) | (TC48's) |
| TC50 | `booking-reschedule.spec.ts` | View My Booking → calendar at 7:45–8:45 PM (8:45–9:00 freed) | (TC48's) |
| TC51 | `booking-reschedule.spec.ts` | 15 min later — book 8–9 PM (9:00–9:15 PM must also be free in that bay) | Yes |
| TC52 | `booking-reschedule.spec.ts` | ⋮ → 15 min later → Reschedule booking: Current 8:00–9:00 PM, New 8:15–9:15 PM → Confirm changes → Booking Confirmed 8:15–9:15 PM (stays 10 s) | (TC51's) |
| TC53 | `booking-reschedule.spec.ts` | View My Booking → calendar at 8:15–9:15 PM (8:00–8:15 freed) | (TC51's) |
| TC62 | `booking-reschedule-rules.spec.ts` | Only once — book a slot with the reschedule time free after it | Yes |
| TC63 | `booking-reschedule-rules.spec.ts` | Reschedule it → the calendar shows the new time | (TC60's) |
| TC64 | `booking-reschedule-rules.spec.ts` | After one reschedule: Reschedule ("Not available…"), 15 min earlier and 15 min later are all disabled | (TC60's) |
| TC65 | `booking-reschedule-rules.spec.ts` | Leave unchanged — book a slot | Yes |
| TC66 | `booking-reschedule-rules.spec.ts` | "How to reschedule" → Back: no reschedule mode, booking unchanged | (TC63's) |
| TC67 | `booking-reschedule-rules.spec.ts` | Reschedule mode: other bays disabled; a 30-min (shorter) new time refused ("must be at least"); X leaves it; booking unchanged | (TC63's) |
| TC68 | `booking-reschedule-rules.spec.ts` | Current/New confirmation → Cancel: booking unchanged | (TC63's) |
| TC69 | `booking-reschedule-rules.spec.ts` | Reschedule details closed without confirming: booking unchanged | (TC63's) |
| TC70 | `booking-reschedule-rules.spec.ts` | Update Group Size offers exactly "Up to N players" sizes (no N+1); closed: unchanged | (TC63's) |
| TC71 | `booking-reschedule-rules.spec.ts` | Another date — book a slot | Yes |
| TC72 | `booking-reschedule-rules.spec.ts` | Reschedule to the next day, same bay, first free time of the same length → calendar (skipped if the account may not book that day) | (TC69's) |
| TC73 | `booking-reschedule-rules.spec.ts` | Within 4 hours — book today starting 30 min–3 h 45 min from now (skipped if none free) | Yes |
| TC74 | `booking-reschedule-rules.spec.ts` | Reschedule disabled ("Not available within 4 hours of start"); 15 min earlier / later still offered | (TC71's) |
| TC75 | `booking-reschedule-rules.spec.ts` | Conflicts — book A, then B right after it in the same bay | 2 |
| TC76 | `booking-reschedule-rules.spec.ts` | "15 min later" on A → "already booked", A and B unchanged | (TC73's) |
| TC77 | `booking-reschedule-rules.spec.ts` | Reschedule A onto B's time → "already booked", no confirmation, unchanged | (TC73's) |
| TC78 | `booking-reschedule-rules.spec.ts` | Failures — book a slot | Yes |
| TC79 | `booking-reschedule-rules.spec.ts` | Reschedule API error (simulated 500) + double-click Confirm: exactly 1 request, no success screen, error message (soft check), booking unchanged | No (mocked) |
| TC80 | `booking-reschedule-rules.spec.ts` | Declined card (4000 0000 0000 0002) for the price difference: reschedule fails, error (soft check), booking unchanged (skipped if $0 to pay) | Request only |
| TC54 | `booking-extend.spec.ts` | Book 8–9 PM with the 3 hours after it free in that bay (the popup maximum) | Yes |
| TC55 | `booking-extend.spec.ts` | Extend popup: starts +15 min (− disabled) → + ×3 = +1 hr → − = +45 min → each preset → +3 hr = max (+ disabled, Ends 12:00 AM) → − to the minimum → drag slider to +45 min; label, slider and Ends always match → Continue | (TC54's) |
| TC56 | `booking-extend.spec.ts` | Extend details (new range) → waiver → Confirm → PATCH /booking/extend → Booking Confirmed ending 9:45 PM | (TC54's) |
| TC57 | `booking-extend.spec.ts` | View My Booking → calendar up to 9:45 PM | (TC54's) |
| TC58 | `booking-extend.spec.ts` | Book a free hour, then the hour right after it in the same bay (so there is no time to extend into; the hour after that must be free too) | Yes (2) |
| TC59 | `booking-extend.spec.ts` | ⋮ → Extend Booking → popup says "The time right after your session is already booked" + "Book a new session instead" (no extend slider) → **Same bay, later** (from the blocker's end) → 1 hr, preview shows bay and time → Continue → the new session is selected on the calendar | (TC58's) |
| TC60 | `booking-extend.spec.ts` | Book Now → Booking Details → waiver → Confirm → Booking Confirmed for the new session | Yes |
| TC61 | `booking-extend.spec.ts` | View My Booking → calendar shows the new session; the first booking (not extended) and the blocker are unchanged | (TC58–60's) |
| TC90 | `booking-extend.spec.ts` | Only 30 min free — book a slot, then another booking starting 30 min after it (same bay) | 2 |
| TC91 | `booking-extend.spec.ts` | Extend popup: "Up to 30 min available", slider max 30 min, no +1 hr preset, + disabled at 30 min, "Need more than 30 min?" → Continue | (TC90's) |
| TC92 | `booking-extend.spec.ts` | Extend to the limit → Booking Confirmed → calendar: ends where the next booking starts | (TC90's) |
| TC93 | `booking-extend.spec.ts` | "Already booked" popup (TC58's): "Switch bay, keep playing" when another bay is free → Continue selects it on another bay (not booked); Trackman noted if offered | No |
| TC94 | `booking-extend.spec.ts` | Taken meanwhile — book a slot | Yes |
| TC95 | `booking-extend.spec.ts` | Confirm while the API answers "Bay already booked" (simulated): one request, no success screen, error (soft check), booking keeps its end time | No (mocked) |
| TC96 | `booking-extend.spec.ts` | Past midnight — book the latest free slot of the day | Yes |
| TC97 | `booking-extend.spec.ts` | Extend past 12:00 AM (+ until one slot past midnight; skipped if not free) → Booking Confirmed with the next-day end; saved booking length checked via the API | (TC96's) |
| TC98 | `booking-extend.spec.ts` | Session in progress — book the current 15-min slot (skipped if the app refuses it) | Yes |
| TC99 | `booking-extend.spec.ts` | Floating "Extend session" button → +15 min → Extend details → Booking Confirmed → calendar | (TC98's) |

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
