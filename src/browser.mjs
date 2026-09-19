// One browser session and the actions an agent needs, each answering in words about what happened
// rather than throwing on the first surprise. Targets are refs from a snapshot ("e12") or a short
// description: 'button "Next"', 'link Pricing', or plain text.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { collect, render } from "./snapshot.mjs";

const PROFILE = process.env.AB_PROFILE || join(homedir(), ".cache/agent-browser/profile");
const CREDS = process.env.AB_CREDS || join(homedir(), ".config/rebel-studios/creds.env");

let ctx = null;
let browser = null; // only in ephemeral mode, where the context doesn't own the browser
let page = null;
let inflight = 0;

/** A persistent context, so a login made once survives between sessions. Headless unless AB_HEADED=1. */
export async function session({ fresh = false } = {}) {
  if (ctx && !fresh) return page;
  if (ctx) await ctx.close().catch(() => {});
  const opts = { headless: process.env.AB_HEADED !== "1", viewport: { width: 1280, height: 900 } };
  if (process.env.AB_EPHEMERAL === "1") {
    browser = await chromium.launch({ headless: opts.headless });
    ctx = await browser.newContext({ viewport: opts.viewport });
  } else {
    ctx = await chromium.launchPersistentContext(PROFILE, opts);
  }
  page = ctx.pages()[0] || (await ctx.newPage());
  watch(page);
  ctx.on("page", (p) => { page = p; watch(p); }); // a link that opens a tab: follow it
  return page;
}

function watch(p) {
  p.on("request", () => inflight++);
  const done = () => { inflight = Math.max(0, inflight - 1); };
  p.on("requestfinished", done);
  p.on("requestfailed", done);
  // when the DOM last changed, so "still loading" can be told from "not there"
  p.addInitScript(() => {
    window.__abMut = Date.now();
    new MutationObserver(() => { window.__abMut = Date.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }).catch(() => {});
}

export async function close() {
  if (ctx) await ctx.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  ctx = null;
  browser = null;
  page = null;
}

export async function snapshot(opts = {}) {
  const p = await session();
  return render(await p.evaluate(collect, opts), opts);
}

async function settle(p, ms = 4000) {
  await p.waitForLoadState("domcontentloaded", { timeout: ms }).catch(() => {});
  await p.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
}

export async function open(url) {
  const p = await session();
  const res = await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => ({ error: e.message }));
  await settle(p);
  const status = res?.error ? `could not load: ${res.error.split("\n")[0]}` : res && res.status() >= 400 ? `HTTP ${res.status()}` : "";
  return (status ? status + "\n" : "") + (await snapshot());
}

/** A snapshot ref or a short description, as a Playwright locator for one visible element. */
export async function locate(target) {
  const p = await session();
  const t = String(target).trim();
  if (/^e\d+$/.test(t)) return p.locator(`[data-ab="${t}"]`).first();
  const m = t.match(/^(button|link|textbox|checkbox|radio|tab|menuitem|combobox|heading|option)\s+["“]?(.+?)["”]?$/i);
  const candidates = m
    ? [p.getByRole(m[1].toLowerCase(), { name: m[2] }), p.getByRole(m[1].toLowerCase(), { name: m[2], exact: false })]
    : [p.getByRole("button", { name: t }), p.getByRole("link", { name: t }), p.getByLabel(t), p.getByPlaceholder(t), p.getByText(t, { exact: false })];
  for (const c of candidates) {
    const n = await c.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 5); i++) if (await c.nth(i).isVisible().catch(() => false)) return c.nth(i);
  }
  return null;
}

/**
 * How an element is named in replies: its label, never a field's value. (A value can be a secret
 * just typed by fill_secret; the first version of this read it back into the transcript.)
 */
const describe = async (loc) => loc.evaluate((el) => {
  const tag = el.tagName.toLowerCase();
  const isButton = tag === "input" && ["submit", "button", "reset"].includes(el.type);
  const lab = () => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.innerText; }
    const w = el.closest("label");
    if (!w) return "";
    const c = w.cloneNode(true);
    c.querySelectorAll("select, textarea, input, button").forEach((x) => x.remove());
    return c.textContent;
  };
  const field = ["input", "textarea", "select"].includes(tag) && !isButton;
  const txt = el.getAttribute("aria-label") || (field ? lab() || el.getAttribute("placeholder") || el.getAttribute("name") : isButton ? el.value : el.innerText) || "";
  return `${field ? "field" : tag} "${txt.replace(/\s+/g, " ").trim().slice(0, 60)}"`;
}).catch(() => "element");

/**
 * Make sure a click lands on the target: scroll it into view, and if something else sits on top
 * (a cookie bar, a chat bubble, a sticky footer), press its dismiss button or hide it. Returns a
 * note for each thing moved out of the way.
 */
async function clearPath(p, loc) {
  const notes = [];
  for (let round = 0; round < 3; round++) {
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    const box = await loc.boundingBox().catch(() => null);
    if (!box) return notes;
    const note = await loc.evaluate((target, pt) => {
      const hit = document.elementFromPoint(pt.x, pt.y);
      if (!hit || target === hit || target.contains(hit) || hit.contains(target)) return null;
      let layer = hit;
      for (let n = hit; n && n !== document.body; n = n.parentElement) {
        const pos = getComputedStyle(n).position;
        if (pos === "fixed" || pos === "sticky") { layer = n; break; }
      }
      const say = (el) => `"${(el.innerText || el.getAttribute("aria-label") || el.tagName).replace(/\s+/g, " ").trim().slice(0, 60)}"`;
      const dismiss = [...layer.querySelectorAll('button, a, [role="button"]')].find((b) =>
        /^(accept( all)?( cookies)?|agree|i agree|got it|ok(ay)?|close|dismiss|no,? thanks|reject( all)?|decline|continue without accepting|×|✕|x)$/i.test((b.innerText || b.getAttribute("aria-label") || "").trim()));
      if (dismiss) { dismiss.click(); return `pressed ${say(dismiss)} on an overlay ${say(layer)}`; }
      const what = say(layer); // before hiding: a hidden element has no innerText
      layer.style.setProperty("visibility", "hidden", "important");
      layer.dataset.abHidden = "1";
      return `hid an overlay covering the target: ${what}`;
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    if (!note) return notes;
    notes.push(note);
    await p.waitForTimeout(300);
  }
  return notes;
}

async function after(p, before, notes, { snap = true } = {}) {
  await settle(p, 3000);
  const out = [...notes];
  if (p.url() !== before) out.push(`now at ${p.url()}`);
  if (snap) out.push("", await snapshot({ limit: 40 }));
  return out.join("\n");
}

export async function click(target, opts = {}) {
  const p = await session();
  const loc = await locate(target);
  if (!loc) return `no visible element matches ${JSON.stringify(target)}\n\n${await snapshot({ find: /^e\d+$/.test(target) ? "" : String(target).split(/\s+/).pop(), limit: 20 })}`;
  const what = await describe(loc);
  if (await loc.isDisabled().catch(() => false)) return `${what} is disabled`;
  const notes = await clearPath(p, loc);
  const before = p.url();
  try {
    await loc.click({ timeout: 5000 });
  } catch (e) {
    // last resort: the DOM click, which no overlay can intercept
    await loc.evaluate((el) => el.click()).catch(() => {});
    notes.push(`regular click failed (${e.message.split("\n")[0].slice(0, 80)}); used a DOM click`);
  }
  return after(p, before, [`clicked ${what}`, ...notes], opts);
}

export async function fill(target, value, { submit = false } = {}) {
  const p = await session();
  const loc = await locate(target);
  if (!loc) return `no visible field matches ${JSON.stringify(target)}`;
  await clearPath(p, loc);
  await loc.fill(String(value));
  const what = await describe(loc);
  if (!submit) return `filled ${what}`;
  const before = p.url();
  await loc.press("Enter");
  return after(p, before, [`filled ${what} and pressed Enter`]);
}

/** Read one key from the creds store. The value goes to the page and nowhere else. */
function secretValue(key) {
  const raw = readFileSync(CREDS, "utf8");
  const line = raw.split("\n").find((l) => l.replace(/^export\s+/, "").startsWith(`${key}=`));
  if (!line) return null;
  return line.replace(/^export\s+/, "").slice(key.length + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
}

export async function fillSecret(target, key) {
  if (!/^[A-Z0-9_]+$/.test(key)) return "key must be an env-style name like STRIPE_SECRET_KEY";
  const value = secretValue(key);
  if (value == null) return `no ${key} in the creds store`;
  const p = await session();
  const loc = await locate(target);
  if (!loc) return `no visible field matches ${JSON.stringify(target)}`;
  await clearPath(p, loc);
  await loc.evaluate((el) => { el.dataset.abSecret = "1"; });
  await loc.fill(value);
  return `filled ${await describe(loc)} from ${key} (value not shown; snapshots show it as (secret))`;
}

export async function select(target, option) {
  const loc = await locate(target);
  if (!loc) return `no visible select matches ${JSON.stringify(target)}`;
  const picked = await loc.selectOption({ label: option }).catch(() => loc.selectOption(option)).catch((e) => e);
  return picked instanceof Error ? `could not pick ${JSON.stringify(option)}: ${picked.message.split("\n")[0]}` : `picked ${JSON.stringify(option)} in ${await describe(loc)}`;
}

export async function press(key) {
  const p = await session();
  const before = p.url();
  await p.keyboard.press(key);
  return after(p, before, [`pressed ${key}`]);
}

/**
 * Wait for something to appear (or, with gone, to disappear). At the deadline it says which of
 * three things is true: there, still loading (requests in flight or the page still changing), or
 * absent on a page that has gone quiet.
 */
export async function wait(target, { gone = false, timeout = 10000 } = {}) {
  const p = await session();
  const end = Date.now() + timeout;
  const present = async () => {
    const loc = await locate(target).catch(() => null);
    return !!loc;
  };
  while (Date.now() < end) {
    if ((await present()) !== gone) return gone ? `${JSON.stringify(target)} is gone` : `${JSON.stringify(target)} is there`;
    await p.waitForTimeout(250);
  }
  const quietFor = await p.evaluate(() => Date.now() - (window.__abMut || 0)).catch(() => 99999);
  if (inflight > 0 || quietFor < 800) {
    return `still loading after ${timeout / 1000}s: ${inflight} request(s) in flight, page last changed ${Math.round(quietFor)}ms ago; ${JSON.stringify(target)} ${gone ? "still there" : "not there yet"}`;
  }
  return gone ? `${JSON.stringify(target)} is still there and the page is idle` : `absent: the page is idle (no requests, no changes for ${Math.round(quietFor / 100) / 10}s) and nothing matches ${JSON.stringify(target)}`;
}

const FORWARD = /^(next|continue|proceed|save (and|&) continue|save and next|submit|done|finish|confirm|review|get started|continue to .+|next step)\b/i;

/** Press the page's forward button (Next, Continue, Submit...), preferring one in a form or dialog. */
export async function next(opts = {}) {
  const p = await session();
  const found = await p.evaluate((src) => {
    const re = new RegExp(src, "i");
    const els = [...document.querySelectorAll('button, input[type="submit"], a[role="button"], [role="button"], a')];
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
    const name = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    const hits = els.filter((el) => vis(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && re.test(name(el)));
    const score = (el) => (el.closest("form, [role=dialog], dialog, main") ? 2 : 0) - (el.closest("nav, header, footer") ? 3 : 0) + (el.tagName === "BUTTON" || el.type === "submit" ? 1 : 0);
    hits.sort((a, b) => score(b) - score(a));
    if (!hits.length) return { none: els.filter(vis).map(name).filter(Boolean).slice(0, 15) };
    window.__abN = window.__abN || 0;
    const el = hits[0];
    return { ref: el.dataset.ab || (el.dataset.ab = "e" + ++window.__abN) };
  }, FORWARD.source);
  if (found.none) return `no Next/Continue/Submit-style button here. Buttons on the page: ${found.none.map((s) => JSON.stringify(s)).join(", ")}`;
  return click(found.ref, opts);
}

export async function back() {
  const p = await session();
  await p.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  await settle(p);
  return snapshot();
}

export async function screenshot(path, { full = false } = {}) {
  const p = await session();
  await p.screenshot({ path, fullPage: full });
  return `saved ${path}`;
}

export async function js(code) {
  const p = await session();
  const v = await p.evaluate(code).catch((e) => `error: ${e.message.split("\n")[0]}`);
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s ?? "undefined").slice(0, 4000);
}
