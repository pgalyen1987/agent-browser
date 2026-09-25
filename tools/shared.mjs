// Drive the SHARED, visible browser the user is watching (Chromium launched with
// --remote-debugging-port=9224 on their display). One action per call:
//   node tools/shared.mjs goto <url>
//   node tools/shared.mjs click <x> <y>          (page coordinates)
//   node tools/shared.mjs clicktext "<visible text>"
//   node tools/shared.mjs type "<text>"
//   node tools/shared.mjs key <Key>
//   node tools/shared.mjs text                     (visible text of the page, trimmed)
//   node tools/shared.mjs shot <path.png>
//   node tools/shared.mjs url
// It attaches to the tab the user is looking at (the last one) and never closes anything.
import { chromium } from "playwright";

const [cmd, ...args] = process.argv.slice(2);
const browser = await chromium.connectOverCDP("http://localhost:9224");
const ctx = browser.contexts()[0];
const pages = ctx.pages();
const page = pages[pages.length - 1] || (await ctx.newPage());
const out = (s) => process.stdout.write(String(s) + "\n");
try {
  switch (cmd) {
    case "goto":
      await page.goto(args[0], { waitUntil: "domcontentloaded", timeout: 30000 });
      out(`at ${page.url()} - "${await page.title()}"`);
      break;
    case "click":
      await page.mouse.click(Number(args[0]), Number(args[1]));
      out("clicked");
      break;
    case "clicktext":
      await page.getByText(args[0], { exact: false }).first().click({ timeout: 8000 });
      out(`clicked "${args[0]}"`);
      break;
    case "type":
      await page.keyboard.type(args[0]);
      out("typed");
      break;
    case "key":
      await page.keyboard.press(args[0]);
      out(`pressed ${args[0]}`);
      break;
    case "text": {
      const t = await page.evaluate(() => document.body ? document.body.innerText : "");
      out(t.replace(/\n{3,}/g, "\n\n").slice(0, 6000));
      break;
    }
    case "shot":
      await page.screenshot({ path: args[0], timeout: 20000 });
      out(`saved ${args[0]}`);
      break;
    case "url":
      out(`${page.url()} - "${await page.title()}"`);
      break;
    default:
      out("usage: goto|click|clicktext|type|key|text|shot|url");
  }
} finally {
  // Detach by exiting: never call browser.close() here, it could take the user's window with it.
  process.exit(0);
}
