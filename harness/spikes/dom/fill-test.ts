// DOM spike: prove that Playwright can drive Chromium on the Pi (ARM64) under
// Xvfb and fill a real web form by DOM, taking screenshots.
//
// Run (on the Pi, inside an X session, e.g. DISPLAY=:99):
//   bun install
//   DISPLAY=:99 bun run fill-test.ts [url]

import { chromium } from "playwright";

const url = process.argv[2] ?? "https://www.selenium.dev/selenium/web/web-form.html";
const exe = process.env.CHROME_EXECUTABLE ?? "/usr/bin/chromium";

console.log("launching chromium:", exe, "on DISPLAY", process.env.DISPLAY ?? "(unset)");

const browser = await chromium.launch({
  executablePath: exe,
  headless: false,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
console.log("title:", await page.title());
await page.screenshot({ path: "/tmp/dom-spike-before.png", fullPage: true });

// The Selenium test form has predictable field names. If the target is a real
// application form, this block simply reports the fields it could not find.
let filled = 0;
const attempts: Array<[string, string]> = [
  ['input[name="my-text"]', "Hello from the Pi"],
  ['input[name="my-password"]', "secret"],
  ['textarea[name="my-textarea"]', "DOM filling works on ARM64."],
];
for (const [selector, value] of attempts) {
  try {
    await page.fill(selector, value, { timeout: 5000 });
    filled++;
  } catch (err) {
    console.log(`skip ${selector}: ${(err as Error).message.split("\n")[0]}`);
  }
}

await page.screenshot({ path: "/tmp/dom-spike-after.png", fullPage: true });
console.log(`filled ${filled}/${attempts.length} fields`);
console.log("screenshots: /tmp/dom-spike-before.png /tmp/dom-spike-after.png");

await browser.close();
console.log("OK");
