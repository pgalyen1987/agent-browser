// Each friction point from the notes (agent-browser-idea), checked against a local page.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "ab-"));
process.env.AB_EPHEMERAL = "1";
process.env.AB_CREDS = join(dir, "creds.env");
writeFileSync(process.env.AB_CREDS, 'OTHER=1\nexport FAKE_API_KEY="sk-super-secret-9f8e"\n');
const b = await import("../src/browser.mjs");
const page = (name, q = "") => pathToFileURL(join(import.meta.dirname, "fixtures", name)).href + q;
after(() => b.close());

test("a snapshot is compact: 150 nav links become a capped list with the form first", async () => {
  const s = await b.open(page("form.html"));
  assert.ok(s.length < 6000, `snapshot is ${s.length} chars`);
  assert.match(s, /form "Login":/);
  assert.match(s, /\[e\d+\] email "Email" \(required\)/);
  assert.match(s, /… 144 more links in this nav/);
  assert.match(s, /auth: this looks like a login page/);
});

test("refs stay the same across snapshots", async () => {
  const one = (await b.snapshot({ find: "Email" })).match(/\[(e\d+)\] email "Email"/)[1];
  const two = (await b.snapshot({ find: "Email" })).match(/\[(e\d+)\] email "Email"/)[1];
  assert.equal(one, two);
});

test("fill, select, submit through the form, and see the result", async () => {
  await b.fill("Email", "pat@example.com");
  assert.match(await b.select("Plan", "Pro"), /picked "Pro"/);
  const out = await b.next();
  assert.match(out, /clicked button "Next"/);
  assert.match(await b.fill("Email", "x@y.z"), /filled field "Email"/);
  assert.match(await b.js("document.getElementById('msg').textContent"), /Welcome pat@example.com/);
});

test("a secret goes into the page and never into the output", async () => {
  const out = await b.fillSecret("API key", "FAKE_API_KEY");
  assert.doesNotMatch(out, /sk-super-secret/);
  assert.equal(await b.js("document.querySelector('[name=key]').value"), "sk-super-secret-9f8e");
  const snap = await b.snapshot({ find: "API key" });
  assert.match(snap, /"API key" = \(secret\)/);
  assert.doesNotMatch(snap, /sk-super-secret/);
  assert.match(await b.fillSecret("API key", "NOPE_KEY"), /no NOPE_KEY/);
});

test("a click under a cookie bar presses Accept; under a chat widget with no close button, hides it", async () => {
  await b.open(page("overlay.html"));
  const out = await b.click('button "Continue to payment"', { snap: false });
  assert.match(out, /pressed "Accept all" on an overlay/);
  assert.equal(await b.js("document.title"), "Paid");
  const help = await b.click('button "Help"', { snap: false });
  assert.match(help, /hid an overlay covering the target: "Chat with us/);
  assert.equal(await b.js("document.body.dataset.help"), "1");
});

test("wait tells there, still loading and absent apart", async () => {
  await b.open(page("slow.html", "?mode=late"));
  assert.match(await b.wait("Download report", { timeout: 5000 }), /is there/);
  await b.open(page("slow.html", "?mode=busy"));
  assert.match(await b.wait("Download report", { timeout: 1500 }), /still loading/);
  await b.open(page("slow.html"));
  assert.match(await b.wait("Download report", { timeout: 1500 }), /absent: the page is idle/);
});

test("a missing target answers in words with nearby options", async () => {
  await b.open(page("form.html"));
  assert.match(await b.click('button "Delete account"'), /no visible element matches/);
});

test("upload through a styled button; a confirm is dismissed unless the click says confirm: true", async () => {
  await b.open(page("upload.html"));
  const f = join(dir, "bundle.zip");
  writeFileSync(f, "zip");
  assert.match(await b.upload('button "Upload a file"', [f]), /attached bundle.zip/);
  assert.equal(await b.js("document.getElementById('name').textContent"), "bundle.zip");
  const no = await b.click('button "Replace"', { snap: false });
  assert.match(no, /a confirm said: "Replace the current file\?" \(dismissed; click again with confirm: true/);
  assert.notEqual(await b.js("document.title"), "Replaced");
  const yes = await b.click('button "Replace"', { snap: false, confirm: true });
  assert.match(yes, /\(accepted\)/);
  assert.equal(await b.js("document.title"), "Replaced");
});

// ── The devtools tools, and the two traps that cost a live afternoon on 2026-09-25 ──

test("the console reports errors, warnings and uncaught exceptions for THIS page", async () => {
  await b.open(page("devtools.html"));
  const all = await b.consoleMessages();
  assert.match(all, /a real error in the page/);
  assert.match(all, /a warning about something/);
  const errs = await b.consoleMessages({ level: "error" });
  assert.match(errs, /a real error in the page/);
  // level:"error" means errors and uncaught exceptions, not warnings.
  assert.doesNotMatch(errs, /a warning about something/);
});

test("the network log keeps the page's OWN request, and finds a third-party call", async () => {
  // Regression: clearing on framenavigated ran AFTER the document's own response event, so the
  // main document vanished from its own log and it read "no requests recorded for this page".
  const all = await b.network();
  assert.doesNotMatch(all, /no requests recorded/);
  // The fixture fires one cross-origin request, which is how a tracker pixel shows up.
  const third = await b.network({ thirdParty: true });
  assert.match(third, /invalid-test-domain/);
});

test("select works on an ARIA listbox, not just a <select>", async () => {
  // Real design systems build dropdowns from [role=listbox] + [role=option]; Playwright's
  // selectOption throws on all of them. Hit on Google Groups' privacy settings.
  const out = await b.select('Who can join group', "Anyone can join");
  assert.match(out, /picked "Anyone can join"/);
  assert.doesNotMatch(out, /did not report itself selected/);
  assert.equal(
    await b.js(`document.querySelector('#who [role=option][aria-selected=true]').textContent.trim()`),
    "Anyone can join",
  );
});

test("an ambiguous target says so instead of silently taking the first", async () => {
  // Two visible "Save" controls. Acting on the first is fine; doing it silently is not - that is
  // how a click meant for a wizard's submit reopened a sidebar instead.
  const out = await b.click("Save");
  assert.match(out, /clicked/);
  assert.match(out, /2 visible elements match "Save"/);
  assert.match(out, /Pass a snapshot ref/);
});

test("a bot wall is named, not snapshotted as an empty page", async () => {
  // Reddit answers a blocked request with a styled page carrying almost no interactive elements,
  // so the snapshot read like a site with nothing on it and the caller went hunting for selectors
  // that were never going to exist. This REPORTS the wall; it does not get around it.
  const s = await b.open(page("blocked.html"));
  assert.match(s, /^blocked: this is an interstitial bot check/m);
  assert.match(s, /Cloudflare/);
  assert.match(s, /already signed in to/);
});

test("an ordinary page is not mistaken for a bot wall", async () => {
  const s = await b.open(page("form.html"));
  assert.doesNotMatch(s, /^blocked:/m);
});
