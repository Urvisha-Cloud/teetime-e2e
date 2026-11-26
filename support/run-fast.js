// npm run test:fast — the main run (or any Playwright arguments given) with TEETIME_FAST=true: the same tests and
// checks, but without the pauses that are only there to watch the run (TEETIME_READ_MS, TEETIME_SHOW_MS, the email
// waits), the drawn cursor and the YopMail window. The popups that need you (gift card code, wallet in admin) stay.
// A small launcher so it works the same in PowerShell, cmd and on a Mac (no shell-specific `set VAR=…`).
const { spawn } = require("child_process");
const path = require("path");

const cli = path.resolve(__dirname, "..", "node_modules", "@playwright", "test", "cli.js");
const args = process.argv.slice(2);
const child = spawn(process.execPath, [cli, "test", ...(args.length ? args : ["tests/main.spec.ts", "--headed"])], {
  stdio: "inherit",
  env: { ...process.env, TEETIME_FAST: "true" },
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
