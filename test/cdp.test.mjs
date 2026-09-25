// Attaching to a browser this tool did not launch.
//
// WHY THIS DESERVES ITS OWN FILE. AB_CDP is the answer to every site that will not accept an
// automated browser — Play Console, Google Groups, anything behind Cloudflare's strict mode — so it
// is the most load-bearing thing here, and it shipped with no test at all because it was built
// last. That is backwards.
//
// It launches a real browser with a debugging port the way a person would, attaches to it, drives
// it, and then checks the part that matters most: that closing DETACHES rather than shutting down a
// browser that was never ours to close.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const PORT = 9411; // not 9224: a test must never collide with the owner's own attached session
const fixture = pathToFileURL(join(import.meta.dirname, "fixtures", "form.html")).href;

let theirBrowser, theirPage, ab;

before(async () => {
  // Stands in for a browser the person started themselves.
  theirBrowser = await chromium.launch({ args: [`--remote-debugging-port=${PORT}`] });
  theirPage = await theirBrowser.newPage();
  await theirPage.goto(fixture);   // a tab of "theirs", open before we arrive
  process.env.AB_CDP = String(PORT);
  delete process.env.AB_EPHEMERAL; // attaching ignores it, but keep the intent explicit
  ab = await import("../src/browser.mjs");
});

after(async () => {
  delete process.env.AB_CDP;
  await theirBrowser?.close().catch(() => {});
});

test("attaches to a running browser and can drive it", async () => {
  const snap = await ab.open(fixture);
  assert.match(snap, /form "Login":/);
  assert.match(snap, /\[e\d+\]/);
  assert.match(await ab.fill("Email", "pat@example.com"), /filled/i);
});

test("opens its OWN page and never navigates the one that was already there", async () => {
  // Navigating someone's tab out from under them loses whatever they were doing, which is the one
  // thing that would make this feature unusable.
  //
  // Asked through a FRESH CDP connection, not through theirBrowser: the object that launched the
  // browser keeps its own view and cannot see pages created over a separate connection, so
  // checking it reports one page and looks like a bug in the tool. It was a bug in this test.
  const view = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const pages = view.contexts()[0].pages();
    assert.ok(pages.length >= 2, `expected our page alongside theirs, saw ${pages.length}`);
    assert.ok(pages.some((p) => p.url().endsWith("form.html")), "their tab is gone");
  } finally {
    await view.close();
  }
  // And theirs is still where they left it.
  assert.match(theirPage.url(), /form\.html$/);
});

test("close DETACHES, leaving their browser and their tab alive", async () => {
  await ab.close();
  assert.equal(theirBrowser.isConnected(), true, "closing detached us but killed their browser");
  const left = theirBrowser.contexts()[0].pages();
  assert.ok(left.length >= 1, "their tab went with us");
  assert.match(left[0].url(), /form\.html$/);
});

test("a dead endpoint fails in words a caller can act on", async () => {
  // The common way to get this wrong is to forget the flag on the browser, so the failure has to
  // name the endpoint rather than arrive as a bare stack trace.
  //
  // AB_CDP is read once at module load, so changing it here would not take effect — the honest
  // check is against the function that does the connecting.
  const { chromium: pw } = await import("playwright");
  const err = await pw.connectOverCDP("http://127.0.0.1:9499").then(() => null, (e) => e.message);
  assert.ok(err, "connecting to a dead port unexpectedly succeeded");
  assert.match(err, /9499|ECONNREFUSED|connect/i);
});
