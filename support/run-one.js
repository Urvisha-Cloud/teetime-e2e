// npm run test:one -- TC5   (or a word from a test's title): one test, in a visible window.
// A test number alone ("TC5", "tc5") becomes "TC5:", so it runs exactly TC5 — Playwright's -g matches any part of a
// title, and a bare "TC5" would also run TC50–TC57. Anything else is passed to -g as it is. Other options (e.g.
// --debug, --project=desktop-safari) go through to Playwright.
const { spawn } = require("child_process");
const path = require("path");

const cli = path.resolve(__dirname, "..", "node_modules", "@playwright", "test", "cli.js");
const args = process.argv.slice(2);
const at = args.findIndex((a) => !a.startsWith("-"));
if (at < 0) {
  console.error('Which test? npm run test:one -- TC5   (a test number, or a word from its title in quotes)');
  process.exit(1);
}
const asked = args[at].trim();
const grep = /^TC\d+$/i.test(asked) ? `${asked.toUpperCase()}:` : asked;
const rest = args.filter((_, i) => i !== at);
console.log(`[teetime-e2e] test:one -g "${grep}"`);
const child = spawn(process.execPath, [cli, "test", ...rest, "-g", grep], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
