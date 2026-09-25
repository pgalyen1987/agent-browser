// What an agent actually pays to read a page it has never seen: in characters, and in seconds.
//
// The claims on the README and the landing page are ratios, so they have to be reproducible by
// anyone who doubts them. This runs both routes against the same live pages and prints both costs.
//
// THE TWO ROUTES, end to end, because that is what a caller experiences:
//
//   Playwright   goto(waitUntil: "networkidle") then locator("body").ariaSnapshot()
//                — the accessibility tree an agent is handed to decide what to click, which is the
//                  role it plays in Playwright's own MCP server.
//
//   this tool    open(url) from src/browser.mjs — its own settle(), then the compact outline.
//
// Each route gets its own fresh browser and its own navigation, so neither warms a cache for the
// other. Pages are fetched once per route and in the same order.
//
// TOKENS ARE ESTIMATED and the estimate is stated rather than hidden: ~4 characters per token is
// the usual rule of thumb for English prose and markup. It is close enough to compare two
// representations of the SAME page, which is all it is used for. It is not a billing figure.
//
//   node bench/compare.mjs            the default page set
//   node bench/compare.mjs <url>...   your own pages
import { chromium } from "playwright";
import * as ab from "../src/browser.mjs";

// Public pages that stay put, spanning the shapes an agent meets: a trivial page as a floor, a
// docs page, a dense reference, a link list and a very large article.
const DEFAULT_PAGES = [
  "https://example.com/",
  "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
  "https://news.ycombinator.com/",
  "https://playwright.dev/docs/intro",
  "https://en.wikipedia.org/wiki/Accessibility",
];

const tokens = (chars) => Math.round(chars / 4);
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const secs = (ms) => (ms / 1000).toFixed(1) + "s";

const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PAGES;
const rows = [];

// ── route A: raw Playwright, the way an agent is usually given a page ──────────────────────────
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
for (const url of urls) {
  const row = { url: new URL(url).host + new URL(url).pathname.replace(/\/$/, "") };
  const t0 = Date.now();
  try {
    // networkidle is what "wait until the page is ready" usually means, and it is the thing this
    // tool deliberately does not do. Capped, because on a page that polls it never arrives at all.
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
  } catch {
    row.ariaTimedOut = true; // it never went quiet; the agent waits out the clock and continues
  }
  try {
    row.aria = (await page.locator("body").ariaSnapshot()).length;
  } catch (e) {
    row.error = e.message.split("\n")[0].slice(0, 50);
  }
  row.ariaMs = Date.now() - t0;
  rows.push(row);
}
await browser.close();

// ── route B: this tool, exactly as a caller gets it ───────────────────────────────────────────
process.env.AB_EPHEMERAL = "1"; // a throwaway profile, so no saved login or cache skews it
for (const row of rows) {
  const url = urls[rows.indexOf(row)];
  const t0 = Date.now();
  try {
    row.ours = (await ab.open(url)).length;
  } catch (e) {
    row.error = (row.error || "") + " " + e.message.split("\n")[0].slice(0, 50);
  }
  row.oursMs = Date.now() - t0;
}
await ab.close();

// ── the table ─────────────────────────────────────────────────────────────────────────────────
const H = `${pad("page", 42)} ${lpad("Playwright", 11)} ${lpad("this", 8)} ${lpad("smaller", 8)} ${lpad("PW time", 9)} ${lpad("this", 7)}`;
console.log("\n" + H + "\n" + "-".repeat(H.length));
for (const r of rows) {
  const ratio = r.aria && r.ours ? (r.aria / r.ours).toFixed(1) + "x" : "-";
  console.log(
    `${pad(r.url.slice(0, 42), 42)} ${lpad((r.aria ?? "-").toLocaleString(), 11)} ${lpad((r.ours ?? "-").toLocaleString(), 8)} ` +
      `${lpad(ratio, 8)} ${lpad(secs(r.ariaMs) + (r.ariaTimedOut ? "*" : ""), 9)} ${lpad(secs(r.oursMs), 7)}`,
  );
}

const ok = rows.filter((r) => r.aria && r.ours);
if (ok.length) {
  const aria = ok.reduce((a, r) => a + r.aria, 0), ours = ok.reduce((a, r) => a + r.ours, 0);
  const ariaMs = ok.reduce((a, r) => a + r.ariaMs, 0), oursMs = ok.reduce((a, r) => a + r.oursMs, 0);
  const ratios = ok.map((r) => r.aria / r.ours).sort((a, b) => a - b);
  console.log("-".repeat(H.length));
  console.log(
    `${pad(`total, ${ok.length} pages`, 42)} ${lpad(aria.toLocaleString(), 11)} ${lpad(ours.toLocaleString(), 8)} ` +
      `${lpad((aria / ours).toFixed(1) + "x", 8)} ${lpad(secs(ariaMs), 9)} ${lpad(secs(oursMs), 7)}`,
  );
  console.log(`\nsize   ~${tokens(aria).toLocaleString()} tokens vs ~${tokens(ours).toLocaleString()}, at 4 chars/token (an estimate, stated as one).`);
  console.log(`       ${ratios[0].toFixed(1)}x to ${ratios[ratios.length - 1].toFixed(1)}x smaller per page.`);
  console.log(`time   ${secs(ariaMs)} vs ${secs(oursMs)} for ${ok.length} pages — ${(ariaMs / oursMs).toFixed(1)}x ${ariaMs > oursMs ? "faster" : "SLOWER"}.`);
  if (rows.some((r) => r.ariaTimedOut)) console.log(`       * networkidle never arrived; that page waited out its 20s cap.`);
  console.log(`\nMeasured ${new Date().toISOString().slice(0, 10)}. Live pages change, so re-run it rather than trusting this line.`);
}
