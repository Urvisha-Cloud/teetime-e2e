// npm run chrome:login — open the test Chrome profile (TEETIME_CHROME_PROFILE) in your normal Chrome app, not a
// test-driven one, so Google lets you sign in. Sign in to your Google account there yourself, then close Chrome:
// later test runs open that same profile already signed in. Nothing is typed for you and no password is stored here;
// Chrome keeps the login inside the profile folder (under .auth/, git-ignored).
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const setting = (process.env.TEETIME_CHROME_PROFILE || "").trim();
if (!setting) {
  console.error("Set TEETIME_CHROME_PROFILE in .env first (e.g. TEETIME_CHROME_PROFILE=.auth/chrome-profile).");
  process.exit(1);
}
const profile = path.resolve(__dirname, "..", setting);
fs.mkdirSync(profile, { recursive: true });

const candidates = {
  win32: [
    path.join(process.env.PROGRAMFILES || "C:/Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:/Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
}[process.platform] || [];
const chrome = candidates.find((p) => p && fs.existsSync(p));
if (!chrome) {
  console.error("Google Chrome not found. Install it, or open it yourself with --user-data-dir=" + profile);
  process.exit(1);
}

spawn(chrome, [`--user-data-dir=${profile}`, "--no-first-run", "https://accounts.google.com/"], {
  detached: true,
  stdio: "ignore",
}).unref();
console.log(`Chrome opened with the test profile ${profile}.`);
console.log("Sign in there, then close that Chrome window. The tests can only open the profile while it is closed.");
