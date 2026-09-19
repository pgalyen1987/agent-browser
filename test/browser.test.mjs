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

test("upload through a styled button, and a confirm dialog is accepted and reported", async () => {
  await b.open(page("upload.html"));
  const f = join(dir, "bundle.zip");
  writeFileSync(f, "zip");
  assert.match(await b.upload('button "Upload a file"', [f]), /attached bundle.zip/);
  assert.equal(await b.js("document.getElementById('name').textContent"), "bundle.zip");
  const out = await b.click('button "Replace"', { snap: false });
  assert.match(out, /a confirm said: "Replace the current file\?" \(accepted\)/);
  assert.equal(await b.js("document.title"), "Replaced");
});
