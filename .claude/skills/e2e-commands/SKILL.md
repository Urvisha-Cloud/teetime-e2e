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
| Added a test case (new `TCxx`) | Add a row to **Single tests** (TC, file, what it checks, real booking). Update the counts ("The 57 cases of `npm test`"). |
| Added a spec file | Add a row to **Run groups** if it gets its own npm script; add its tests to **Single tests**. |
| Added / renamed / removed an npm script | Add / rename / remove its row in **Run groups** (or **Setup**, **Reports and debugging**). |
| Changed what a command runs | Fix the "What it runs" and "Real booking" cells. |
| A test now creates (or stops creating) a booking | Fix the "Real booking" cells. |
| Changed login or settings (`.env`) | Update **Good to know**. |

## The main run (`npm test`)

* `npm test` runs **`tests/main.spec.ts`**, the only spec file. It imports the step files of `tests/main` in run order
  (`card-flow`, `card-quick-shift`, `card-refund`, `card-switch-bay`, `wallet`, `wallet-gift-card`, `gift-card`,
  `membership`): the imports set the order, not the file names. The step files end in `.ts`, not `.spec.ts`, so
  Playwright never runs them a second time on their own.
* Each step's `test.describe` titles carry its tag (`@card-flow`, `@card-quick-shift`, `@card-refund`,
  `@card-switch-bay`, `@wallet-credit`, `@wallet-gift-card`, `@gift-card`, `@membership`). A step command is
  `playwright test tests/main.spec.ts --grep @<tag> --headed`. A tag must not be part of another tag (that is why the
  wallet step is `@wallet-credit`, not `@wallet`).
* A new case for the main run goes into the file of its step: it is in `npm test` by itself. A new step is a new file
  in `tests/main` with its own tag, imported in `tests/main.spec.ts` at its place. Both still need their **Single
  tests** rows and the main-run row's description in COMMANDS.md.
* Files in `tests/main` import one folder up: `../helper`, `../fixtures`, `../money`, `../../support/…`.
* Every case is part of the main run: the suite has only `tests/main` (TC1–TC57, numbered in run order). A new case
  gets the next free number, or the cases after it are renumbered so the numbers keep following the run order.

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
* Real booking column: `No`, `Yes`, or `(TC2's)` for steps that reuse another test's booking.

## Rules for new commands

* Add a `package.json` script for anything run more than once (a shortcut: `npm run <name>`), and document it in
  COMMANDS.md with both forms: `npm run <name>` and its `npx playwright test …` command.
  Name it `test:<area>` (e.g. `test:wallet`). **Every test script must include `--headed`** (or `--ui`): the user
  always watches the tests in a visible Chrome window.
* Never document `npm playwright …` — it is not valid. Use `npx playwright …` or an npm script.
* Extra options go at the end of the npx command: `npx playwright test tests/main.spec.ts --grep @wallet-credit --headed --debug`.

## Checking

1. `npm run` — every script must appear in COMMANDS.md with both its npm name and its npx form, and nothing else.
2. `npx playwright test --list` — every TC in the output must appear in **Single tests**; counts must match.
3. For a new or changed script: `npx playwright test <same args> --list` selects the tests the table says.
4. Also update the README "Run" and "Test cases" tables if they cover the same change.
