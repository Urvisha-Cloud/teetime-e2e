---
name: e2e-commands
description: Keep teetime-e2e/COMMANDS.md (the table of every test command) in sync. Use whenever you add, rename or remove a test case (TCxx), a spec file, an npm script in teetime-e2e/package.json, or change what a command runs or whether it creates bookings — and when the user asks which command runs something.
---

# TeeTime E2E command list

`teetime-e2e/COMMANDS.md` is the single place that lists every command for the E2E suite, in tables.
It must always match `package.json` and the tests. Update it **in the same change** as the code.

## When to update COMMANDS.md

| You changed | Update in COMMANDS.md |
|---|---|
| Added a test case (new `TCxx`) | Add a row to **Single tests** (TC, file, what it checks, real booking). Update the test counts in **Run groups** (e.g. "Everything (24 tests)"). |
| Added a spec file | Add a row to **Run groups** if it gets its own npm script; add its tests to **Single tests**. |
| Added / renamed / removed an npm script | Add / rename / remove its row in **Run groups** (or **Setup**, **Reports and debugging**). |
| Changed what a command runs | Fix the "What it runs" and "Real booking" cells. |
| A test now creates (or stops creating) a booking | Fix the "Real booking" cells, the `@creates-booking` notes, and `test:booking` / `test:readonly` rows. |
| Changed login or settings (`.env`) | Update **Good to know**. |

## Table format (keep it)

* **Run groups:** `| npm | npx (the same command in full) | What it runs | Real booking |` (no Chrome / visible
  column: every command is visible).
* **Single tests:** `| TC | File | What it checks | Real booking |`, sorted by TC number (ranges like `TC1–5` are fine).
* **Setup** and **Reports and debugging:** `| npm | npx (the same command in full) | What it does |`
* **Both forms of every command** (the user asked for npm and npx): the **npm** column has the short name from
  `package.json` (`npm test`, `npm run test:extend`, …; several names that run the same command: `a` / `b`), the
  **npx** column the same command in full — the exact value of that script with `npx ` in front (`node …` and
  `npm ci` as they are). No npm script for a command: "—" in the npm column. Commands in backticks. Escape `|` inside
  table cells as `\|` (e.g. in `--grep "A\|B"`) — in BOTH places, or the table breaks.
* Real booking column: `No`, `Yes`, `No (mocked)`, `Request only` (real create request, booking deleted again by the
  backend), or `(TC11's)` for steps that reuse another test's booking.

## Rules for new commands

* Add a `package.json` script for anything run more than once (a shortcut: `npm run <name>`), and document it in
  COMMANDS.md with both forms: `npm run <name>` and its `npx playwright test …` command.
  Name it `test:<area>` (e.g. `test:payment`). **Every test script must include `--headed`** (or `--ui`): the user
  always watches the tests in a visible Chrome window.
* Exception: the unattended daily run (`run-readonly.cmd`, Task Scheduler) calls `npx playwright test …` directly
  without `--headed`, so no window pops up. Don't point it at an npm script.
* Never document `npm playwright …` — it is not valid. Use `npx playwright …` or an npm script.
* Extra options go at the end of the npx command: `npx playwright test tests/payment-negative.spec.ts --headed --debug`.

## Checking

1. `npm run` — every script must appear in COMMANDS.md with both its npm name and its npx form, and nothing else.
2. `npx playwright test --list` — every TC in the output must appear in **Single tests**; counts must match.
3. For a new or changed script: `npx playwright test <same args> --list` selects the tests the table says.
4. Also update the README "Run" and "Test cases" tables if they cover the same change.
