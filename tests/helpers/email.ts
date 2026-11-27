// Booking emails: the test user's YopMail inbox in a Chrome window next to the test window (visible runs).
import type { TestInfo } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { BookingApp, type CreatedBooking } from "../../support/booking-app";
import { env } from "../../support/env";
import { testUser } from "../fixtures";

// ───────────────────────────── booking email (YopMail) ─────────────────────────────

/**
 * Timing of each email step, in order before the next step: the checkout screen -> TEETIME_EMAIL_ARRIVE_MS (default
 * 1 s; a new booking's email takes longer: TEETIME_NEW_BOOKING_EMAIL_ARRIVE_MS, 8 s) -> the inbox opens ONCE (one new tab), the window on top — YopMail opens the NEWEST email by itself — it loads
 * (YOPMAIL_LOAD_MS) and stays visible YOPMAIL_SHOW_MS (1 s) -> the window moves behind the test browser -> next step.
 * If the new email has not arrived by then, the newest one is still the PREVIOUS email (after create the last cancel
 * email or the login code, after a reschedule the create email, after a cancel the reschedule email) and the test
 * cannot click another email in that window: then raise these two in .env.
 */
const YOPMAIL_LOAD_MS = 4_000;
const YOPMAIL_SHOW_MS = 1_000;

/** Which booking email the step after a change expects on top of the inbox (for the note and the console). */
type EmailKind = "confirmed" | "rescheduled" | "group size" | "extended" | "cancelled";
const EMAIL_SUBJECT: Record<EmailKind, string> = {
  confirmed: "Your TeeTime booking is confirmed",
  rescheduled: "Your TeeTime booking is rescheduled",
  "group size": "booking updated (group size)",
  extended: "booking extended",
  cancelled: "booking cancelled",
};

/** Your installed Google Chrome app, or undefined when it is not found. */
function chromeApp(): string | undefined {
  const candidates =
    process.platform === "win32"
      ? [
          path.join(process.env.PROGRAMFILES || "C:/Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] || "C:/Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  return candidates.find((p) => p && fs.existsSync(p));
}

/** The one YopMail window of this run (its Chrome process), kept open between the email steps. */
let yopmailWindow: ChildProcess | undefined;

/**
 * Show the newest email of the test user's YopMail inbox (e.g. teetime-e2e-…@yopmail.com) in a separate, NORMAL
 * Chrome window — not the test browser, where YopMail's Cloudflare check always fails.
 *
 * The YopMail window stays open for the whole run. Each call (after create, reschedule, group size, extend, cancel)
 * opens the inbox again in that window (a new tab, so it shows the newest email), puts the window ON TOP of the
 * test browser for the load time + 1 s, then moves it BEHIND the test browser and goes back to the booking site;
 * the next case runs and the next call brings the YopMail window to the top again. Closed it yourself? The next
 * call opens a new one. It stays open after the run; close it whenever you like.
 *
 * The window has its own small profile (.auth/yopmail-browser, git-ignored); the test never controls or reads the
 * page, so it does not check the email. Never skips or fails the test it runs in: when it cannot run (background
 * run, a test user that is not a YopMail address, no Chrome), it only adds a note.
 */
export async function showBookingEmail(app: BookingApp, testInfo: TestInfo, b: CreatedBooking, kind: EmailKind = "confirmed") {
  const skip = (why: string) => testInfo.annotations.push({ type: "booking-email", description: `${EMAIL_SUBJECT[kind]}: not shown (${why})` });
  const email = (testUser.email ?? env.testEmail).toLowerCase();
  if (!email.endsWith("@yopmail.com")) return skip(`the test user ${email || "(none)"} is not a YopMail address`);
  if (testInfo.project.use.headless !== false) return skip("visible runs only (--headed)");
  if (!env.showEmails) return skip(env.fast ? "fast run" : "TEETIME_SHOW_EMAILS=false");
  const chrome = chromeApp();
  if (!chrome) return skip("Google Chrome not found");

  const profile = path.join(path.dirname(env.storageState), "yopmail-browser");
  fs.mkdirSync(profile, { recursive: true });
  const inbox = `https://yopmail.com/en/?login=${encodeURIComponent(email.split("@")[0])}`;
  const look = `${b.startTime} – ${b.endTime}, ${b.bayName}`;

  const args = [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble", inbox];
  const openInbox = (): ChildProcess => {
    if (!yopmailWindow) {
      // First email of the run (or you closed the window): a new YopMail window
      const started = spawn(chrome, ["--start-maximized", "--new-window", ...args], { stdio: "ignore" });
      started.once("exit", () => {
        if (yopmailWindow === started) yopmailWindow = undefined;
      });
      yopmailWindow = started;
    } else {
      // Window already open: the same Chrome opens the inbox in a new tab there (shows the newest email)
      spawn(chrome, args, { stdio: "ignore" }).unref();
    }
    return yopmailWindow;
  };

  // In order, before the next step: checkout screen -> TEETIME_EMAIL_ARRIVE_MS (1 s) -> YopMail on top with this
  // step's email -> loaded + 1 s visible -> behind -> the test browser in front again -> the next step
  testInfo.annotations.push({ type: "booking-email", description: `${EMAIL_SUBJECT[kind]}: shown in YopMail (${inbox}; ${look})` });
  const arriveMs = kind === "confirmed" ? Math.max(env.emailArriveMs, env.newBookingEmailArriveMs) : env.emailArriveMs;
  if (arriveMs > 0) await app.page.waitForTimeout(arriveMs);
  console.log(`[teetime-e2e] YopMail window on top: "${EMAIL_SUBJECT[kind]}" (${look})`);
  await moveWindow(openInbox().pid, "top");
  await app.page.waitForTimeout(YOPMAIL_LOAD_MS + YOPMAIL_SHOW_MS);
  await moveWindow(yopmailWindow?.pid, "behind");
  await app.page.bringToFront(); // back to the booking site tab
  await raiseTestWindow(app); // visibly in front again, even when another window such as VS Code was on top
}

/** Run a PowerShell script (Windows) and wait until it is done; errors are ignored (only window placement). */
function runPowerShell(script: string) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise<void>((resolve) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdio: "ignore", windowsHide: true });
    ps.once("exit", () => resolve());
    ps.once("error", () => resolve());
  });
}

/**
 * Windows only: bring the TEST browser's window to the front of every window. The window is found by a unique
 * marker put in the page title for a moment (the test browser's process is not otherwise known), raised with
 * user32 SetWindowPos (on top, then normal again, so it does not stay on top), and the page title restored.
 */
async function raiseTestWindow(app: BookingApp) {
  if (process.platform !== "win32") return;
  const marker = `TeeTimeE2E-${Date.now()}`;
  const title = await app.page.evaluate((m) => {
    const old = document.title;
    document.title = m;
    return old;
  }, marker).catch(() => null);
  if (title === null) return;
  await runPowerShell(
    [
      "$sig = @'",
      '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
      '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
      '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
      "'@",
      "$u = Add-Type -MemberDefinition $sig -Name WinRaise -Namespace TeeTimeE2E -PassThru",
      "for ($i = 0; $i -lt 25; $i++) {",
      `  $p = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${marker}*' } | Select-Object -First 1`,
      "  if ($p) { $h = $p.MainWindowHandle",
      "    if ($u::IsIconic($h)) { [void]$u::ShowWindow($h, 9) }",
      "    [void]$u::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x43); [void]$u::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x43); break }",
      "  Start-Sleep -Milliseconds 200",
      "}",
    ].join("\n"),
  );
  await app.page.evaluate((t) => (document.title = t), title).catch(() => {});
}

/**
 * Windows only: move the YopMail Chrome window (by its process id) to the top of every window ("top", always on
 * top while shown; restored first if minimized) or behind all other windows ("behind", no longer on top), with
 * user32 SetWindowPos. Waits until the window exists (up to 12 s). Nothing happens on other systems.
 */
async function moveWindow(pid: number | undefined, where: "top" | "behind") {
  if (process.platform !== "win32" || !pid) return;
  const action =
    where === "top"
      ? "if ($u::IsIconic($h)) { [void]$u::ShowWindow($h, 9) }; [void]$u::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x43)"
      : "[void]$u::SetWindowPos($h, [IntPtr](1), 0, 0, 0, 0, 0x13)";
  const script = [
    "$sig = @'",
    '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
    '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    "'@",
    "$u = Add-Type -MemberDefinition $sig -Name Win -Namespace TeeTimeE2E -PassThru",
    "for ($i = 0; $i -lt 60; $i++) {",
    `  $p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if (-not $p) { break }`,
    `  $h = $p.MainWindowHandle; if ($h -ne 0) { ${action}; break }`,
    "  Start-Sleep -Milliseconds 200",
    "}",
  ].join("\n");
  await runPowerShell(script);
}
