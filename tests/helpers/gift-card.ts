// Gift cards: the code typed into "Have a gift card?" and the popup that asks you for it.
import type { Locator, TestInfo } from "@playwright/test";
import { BookingApp } from "../../support/booking-app";
import { env } from "../../support/env";
import { expect, test } from "../fixtures";

/** Pause between the keys when the gift card code is typed (ms), so it can be watched. */
export const GIFT_CODE_KEY_DELAY_MS = 150;

/**
 * "Have a gift card?" in Booking Details / Reschedule details -> `code` typed key by key -> Apply. Returns "You pay"
 * before and after. Nothing to pay -> the field is hidden: nothing is applied ({ before: 0, after: 0 }). The app
 * refuses the code (e.g. "Gift code balance exhausted") -> the test is skipped with that reason, before anything is
 * confirmed.
 */
export async function applyGiftCode(
  app: BookingApp,
  testInfo: TestInfo,
  modal: Locator,
  code: string,
  /** A refused code: "skip" the test, or "continue" without the gift card (the card pays). */
  { onRefused = "skip" }: { onRefused?: "skip" | "continue" } = {},
) {
  const before = await app.amountToPay(modal);
  if (before <= 0) return { before, after: before };
  const field = modal.getByPlaceholder(/gift|code/i).or(modal.getByRole("textbox", { name: /gift|code/i })).first();
  // Already open after a refused code (a second click would close it again)
  if (!(await field.isVisible())) await app.guidedClick(modal.getByText(/Have a gift card\?/), { read: app.readMs });
  await expect(field, "gift card code field").toBeVisible();
  // Typed key by key (visible while watching), not pasted in at once
  await app.guidedClick(field);
  await field.clear();
  await field.pressSequentially(code, { delay: GIFT_CODE_KEY_DELAY_MS });
  // Applied: "You pay" goes down — or the app says why the code cannot be used (Apply clears an earlier message)
  const refused = modal.getByText(/balance exhausted|invalid|expired|not found|no balance|already used/i).first();
  await app.guidedClick(modal.getByRole("button", { name: /^(Apply|Redeem|Use)/i }).first(), { read: app.readMs });

  let applied = false;
  for (const end = Date.now() + 15_000; Date.now() < end && !applied; ) {
    if (await refused.isVisible().catch(() => false)) {
      const why = (await refused.innerText()).trim();
      testInfo.annotations.push({ type: "gift-card", description: `${code}: ${why}` });
      if (onRefused === "continue") {
        console.log(`[teetime-e2e] gift card: ${code}: ${why}; the card pays instead`);
        await field.clear();
        return { before, after: before };
      }
      test.skip(true, `The gift card code ${code} cannot be used ("${why}"): enter another code in the popup, or set a new gift card code in .env`);
    }
    applied = (await app.amountToPay(modal)) < before;
    if (!applied) await app.page.waitForTimeout(300);
  }
  expect(applied, `"You pay" lower than $${before.toFixed(2)} after applying the gift card`).toBe(true);
  await expect(modal, "gift card line in the price").toContainText(/gift card/i);
  return { before, after: await app.amountToPay(modal) };
}

/** How long the gift code popup waits for you to enter a code (ms). */
const GIFT_CODE_PROMPT_MS = 5 * 60_000;

/** Computed CSS of the first element of `loc` (`props` only); {} when it is not there. */
async function styleOf(loc: Locator, props: string[]): Promise<Record<string, string>> {
  return loc
    .first()
    .evaluate(
      (e, props) => {
        const s = getComputedStyle(e);
        return Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)]));
      },
      props,
      { timeout: 2_000 },
    )
    .catch(() => ({}));
}

/**
 * Shows a popup over the open modal (`modal`: Booking Details, Reschedule details, Redeem gift card) of the test
 * browser, on a dark overlay over the whole window, and waits for YOU to enter the gift card code to use (e.g. one
 * made in admin): type it, then "Apply this code" (or Enter). The field starts with `suggested` (empty unless given).
 * Returns the code, or "" when you press "Skip" (or nothing is entered within GIFT_CODE_PROMPT_MS). The modal behind
 * stays open: the popup keeps its clicks, focus and keys away from the modal's focus lock and close-on-outside.
 * It looks like the app: its card, heading, input and button styles are copied from the open modal (its own card,
 * heading, the time dropdowns and the Confirm button), with the app's theme colors as the fallback.
 */
export async function askGiftCode(
  app: BookingApp,
  testInfo: TestInfo,
  modal: Locator,
  {
    suggested = "",
    primaryButton,
    target = '"Have a gift card?"',
    hint = "",
  }: {
    suggested?: string;
    /** The modal's main button, whose look "Apply this code" copies (default: Booking Details' Confirm). */
    primaryButton?: Locator;
    /** Where the test types the code, named in the popup's text. */
    target?: string;
    /** An extra line in the popup (e.g. which code the test needs). */
    hint?: string;
  } = {},
): Promise<string> {
  testInfo.setTimeout(testInfo.timeout + GIFT_CODE_PROMPT_MS); // waiting for you does not count against the test
  console.log("[teetime-e2e] gift card: enter the code in the popup in the test browser");
  const theme = {
    card: await styleOf(modal, ["background-color", "color", "border-radius", "box-shadow", "font-family"]),
    title: await styleOf(modal.getByRole("heading"), ["font-size", "font-weight", "color"]),
    field: await styleOf(modal.getByRole("combobox").or(modal.getByRole("textbox")), ["border-top-color", "border-top-width", "border-radius", "background-color", "height"]),
    primary: await styleOf(primaryButton ?? app.confirmButton(modal), ["background-color", "background-image", "color", "border-radius", "font-weight", "box-shadow"]),
  };
  await modal.evaluate(
    (_modalEl, { suggested, theme, target, hint }) => {
      (window as any).__teetimeGiftCode = undefined;
      document.getElementById("teetime-gift-prompt")?.remove();
      // A copied value, unless it is missing or see-through; then the app's theme variable (shadcn: --primary …)
      const pick = (value: string | undefined, fallback: string) =>
        value && value !== "none" && value !== "transparent" && !/^rgba\(\d+, \d+, \d+, 0\)$/.test(value) ? value : fallback;
      const t = theme as Record<string, Record<string, string>>;
      const vars: Record<string, string> = {
        "--g-card": pick(t.card["background-color"], "hsl(var(--card, 0 0% 100%))"),
        "--g-text": pick(t.card["color"], "hsl(var(--card-foreground, 215 28% 17%))"),
        "--g-muted": "hsl(var(--muted-foreground, 215 16% 47%))",
        "--g-radius": pick(t.card["border-radius"], "var(--radius, .75rem)"),
        "--g-shadow": pick(t.card["box-shadow"], "0 25px 50px -12px rgba(0,0,0,.25)"),
        "--g-font": pick(t.card["font-family"], "inherit"),
        "--g-title-size": pick(t.title["font-size"], "1.25rem"),
        "--g-title-weight": pick(t.title["font-weight"], "700"),
        "--g-title-color": pick(t.title["color"], "inherit"),
        "--g-border": pick(t.field["border-top-color"], "hsl(var(--input, 214 32% 91%))"),
        "--g-border-w": pick(t.field["border-top-width"], "1px"),
        "--g-field-radius": pick(t.field["border-radius"], "calc(var(--radius, .75rem) - 2px)"),
        "--g-field-bg": pick(t.field["background-color"], "hsl(var(--background, 0 0% 100%))"),
        "--g-field-h": pick(t.field["height"], "44px"),
        "--g-accent": pick(t.primary["background-color"], "hsl(var(--primary, 217 91% 60%))"),
        "--g-accent-image": pick(t.primary["background-image"], "none"),
        "--g-accent-text": pick(t.primary["color"], "hsl(var(--primary-foreground, 0 0% 98%))"),
        "--g-btn-radius": pick(t.primary["border-radius"], "var(--radius, .75rem)"),
        "--g-btn-weight": pick(t.primary["font-weight"], "600"),
        "--g-btn-shadow": pick(t.primary["box-shadow"], "none"),
      };
      const box = document.createElement("div");
      box.id = "teetime-gift-prompt";
      for (const [k, v] of Object.entries(vars)) box.style.setProperty(k, v);
      const P = "#teetime-gift-prompt";
      box.innerHTML = `
        <style>
          ${P}{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;
            background:rgba(15,23,42,.5);backdrop-filter:blur(2px);pointer-events:auto;font-family:var(--g-font);
            animation:tgFade .15s ease-out}
          ${P} *{box-sizing:border-box}
          ${P} .tg-card{background:var(--g-card);color:var(--g-text);border-radius:var(--g-radius);box-shadow:var(--g-shadow);
            padding:24px;width:min(400px,calc(100% - 32px));animation:tgPop .18s ease-out}
          ${P} .tg-head{display:flex;align-items:center;gap:12px;margin-bottom:8px}
          ${P} .tg-icon{flex:none;width:40px;height:40px;border-radius:9999px;display:grid;place-items:center;
            background:color-mix(in srgb,var(--g-accent) 14%,transparent);color:var(--g-accent)}
          ${P} .tg-title{margin:0;font-size:var(--g-title-size);font-weight:var(--g-title-weight);color:var(--g-title-color);line-height:1.25}
          ${P} .tg-text{margin:0 0 16px;font-size:14px;line-height:1.5;color:var(--g-muted)}
          ${P} label{display:block;font-size:14px;font-weight:500;margin-bottom:6px}
          ${P} input{width:100%;height:var(--g-field-h);padding:0 14px;font:inherit;font-size:16px;letter-spacing:1.5px;
            text-transform:uppercase;color:var(--g-text);background:var(--g-field-bg);border:var(--g-border-w) solid var(--g-border);
            border-radius:var(--g-field-radius);outline:none;transition:border-color .15s,box-shadow .15s}
          ${P} input::placeholder{color:var(--g-muted);letter-spacing:normal;text-transform:none}
          ${P} input:focus{border-color:var(--g-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--g-accent) 25%,transparent)}
          ${P} .tg-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
          ${P} button{height:44px;padding:0 20px;font:inherit;font-size:15px;font-weight:var(--g-btn-weight);
            border-radius:var(--g-btn-radius);cursor:pointer;transition:filter .15s,opacity .15s,background-color .15s}
          ${P} .tg-skip{background:transparent;color:var(--g-text);border:var(--g-border-w) solid var(--g-border)}
          ${P} .tg-skip:hover{background:color-mix(in srgb,var(--g-text) 6%,transparent)}
          ${P} .tg-ok{background-color:var(--g-accent);background-image:var(--g-accent-image);color:var(--g-accent-text);
            border:0;box-shadow:var(--g-btn-shadow)}
          ${P} .tg-ok:hover{filter:brightness(1.07)}
          ${P} .tg-ok:disabled{opacity:.5;cursor:not-allowed;filter:none}
          @keyframes tgFade{from{opacity:0}}
          @keyframes tgPop{from{opacity:0;transform:scale(.96)}}
        </style>
        <div class="tg-card" role="dialog" aria-modal="true" aria-labelledby="teetime-gift-title">
          <div class="tg-head">
            <span class="tg-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/>
                <path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5"/>
              </svg>
            </span>
            <h2 class="tg-title" id="teetime-gift-title">Gift card code</h2>
          </div>
          <p class="tg-text">Enter the gift card code to apply. The test types it into ${target} and continues. <b data-hint></b></p>
          <label for="teetime-gift-input">Code</label>
          <input id="teetime-gift-input" autocomplete="off" spellcheck="false" placeholder="e.g. GOLFXXXXXXXX" />
          <div class="tg-actions">
            <button id="teetime-gift-skip" class="tg-skip" type="button">Skip</button>
            <button id="teetime-gift-ok" class="tg-ok" type="button" disabled>Apply this code</button>
          </div>
        </div>`;
      // On the page itself (not inside the modal), so the overlay covers the whole window
      box.querySelector("[data-hint]")!.textContent = hint;
      document.body.appendChild(box);
      const input = box.querySelector<HTMLInputElement>("#teetime-gift-input")!;
      const ok = box.querySelector<HTMLButtonElement>("#teetime-gift-ok")!;
      const sync = () => (ok.disabled = !input.value.trim()); // "Apply this code" only once a code is typed
      input.value = suggested;
      sync();
      input.addEventListener("input", sync);

      // The app's modal keeps focus inside itself and closes on a click, focus or Escape outside it. Events that
      // start in (or move focus into) the popup are stopped before the modal sees them, so you can click and type
      // here and the modal behind stays open. Enter in the field applies the code.
      const inBox = (n: EventTarget | null) => n instanceof Node && box.contains(n);
      const guarded = ["focusin", "focusout", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "keydown"];
      const guard = (e: Event) => {
        if (!inBox(e.target) && !inBox((e as FocusEvent).relatedTarget ?? null)) return;
        e.stopImmediatePropagation();
        const k = e as KeyboardEvent;
        if (k.type === "keydown" && k.key === "Enter" && k.target === input && input.value.trim()) done(input.value);
      };
      for (const type of guarded) window.addEventListener(type, guard, true);
      const done = (value: string) => {
        for (const type of guarded) window.removeEventListener(type, guard, true);
        (window as any).__teetimeGiftCode = value.trim().toUpperCase().replace(/[\s-]/g, "");
        box.remove();
      };
      ok.addEventListener("click", () => input.value.trim() && done(input.value));
      box.querySelector("#teetime-gift-skip")!.addEventListener("click", () => done(""));
      setTimeout(() => input.focus(), 50);
    },
    { suggested, theme, target, hint },
  );
  const answered = await app.page
    .waitForFunction(() => (window as any).__teetimeGiftCode !== undefined, null, { timeout: GIFT_CODE_PROMPT_MS, polling: 300 })
    .then(() => true, () => false);
  const code = answered ? String(await app.page.evaluate(() => (window as any).__teetimeGiftCode)) : "";
  if (!answered) await app.page.evaluate(() => document.getElementById("teetime-gift-prompt")?.remove()).catch(() => {});
  testInfo.annotations.push({ type: "gift-card", description: code ? `${code} (entered in the popup)` : answered ? "skipped in the popup" : "no code entered in time" });
  return code;
}

/**
 * Booking Details: a popup asks YOU for the gift card code (headless: `headlessCode`, TEETIME_GIFT_CARD_CODE by default)
 * -> applyGiftCode. A refused code (used up, already redeemed, …): the popup asks for another one; the 3rd refused code
 * (headless: the 1st) skips the test with the app's reason. Returns the code and "You pay" before and after it.
 */
export async function askAndApplyGiftCode(
  app: BookingApp,
  testInfo: TestInfo,
  modal: Locator,
  headless: boolean,
  headlessCode = env.giftCardCode,
) {
  const tries = headless ? 1 : 3;
  let code = headless ? headlessCode : await askGiftCode(app, testInfo, modal);
  test.skip(!code, "No gift card code entered in the popup");
  let paid = await applyGiftCode(app, testInfo, modal, code!, { onRefused: tries > 1 ? "continue" : "skip" });
  for (let attempt = 2; paid.after >= paid.before && attempt <= tries; attempt++) {
    code = await askGiftCode(app, testInfo, modal);
    test.skip(!code, "The gift card code was refused and no other code was entered in the popup");
    paid = await applyGiftCode(app, testInfo, modal, code, { onRefused: attempt < tries ? "continue" : "skip" });
  }
  return { code: code!, ...paid };
}
