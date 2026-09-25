// One browser session and the actions an agent needs, each answering in words about what happened
// rather than throwing on the first surprise. Targets are refs from a snapshot ("e12") or a short
// description: 'button "Next"', 'link Pricing', or plain text.
import { chromium, firefox, webkit } from "playwright";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { collect, render } from "./snapshot.mjs";

const PROFILE = process.env.AB_PROFILE || join(homedir(), ".cache/agent-browser/profile");
// AB_BROWSER picks the engine. Chromium is the default because it is what most sites are built
// against and what CDP attach needs, but nothing here is Chromium-specific: the snapshot runs in
// the page, and every action goes through Playwright's own API.
const ENGINES = { chromium, firefox, webkit };
const ENGINE_NAME = (process.env.AB_BROWSER || "chromium").toLowerCase();
const ENGINE = ENGINES[ENGINE_NAME] || chromium;
const CREDS = process.env.AB_CREDS || join(homedir(), ".config/rebel-studios/creds.env");

let ctx = null;
let browser = null; // only in ephemeral mode, where the context doesn't own the browser
let page = null;
let inflight = 0;
let lastReq = 0;
let reqCount = 0; // monotonic: settle uses it to tell whether the page has fetched for itself yet
// DevTools signals an agent cannot get from the DOM. Bounded, because a chatty page would
// otherwise grow these without limit over a long session, and cleared on navigation so
// "errors on this page" means THIS page rather than everything since the server started.
const LOG_CAP = { console: 200, network: 400 };
let consoleLog = [];
let netLog = [];
// Request object -> its log entry, so an outcome can be filled in later. Weak: when Playwright
// drops the Request, the mapping goes with it.
let netIndex = new WeakMap();

/** A persistent context, so a login made once survives between sessions. Headless unless AB_HEADED=1. */
export async function session({ fresh = false } = {}) {
  if (ctx && !fresh) {
    // A CONTEXT CAN DIE UNDER US and the old code handed the dead handle back regardless, so
    // every later call failed with "Target page, context or browser has been closed" - forever,
    // with no recovery short of restarting the server. It happens for ordinary reasons: the
    // browser crashes, another process takes the persistent profile, or anything calls close().
    // Check the handle is alive, reuse a live tab if there is one, and only rebuild if not.
    try {
      if (page && !page.isClosed()) return page;
      const live = ctx.pages().find((q) => !q.isClosed());
      page = live || (await ctx.newPage());
      watch(page);
      return page;
    } catch {
      ctx = null;           // the context itself is gone; fall through and relaunch below
      page = null;
    }
  }
  if (ctx) await ctx.close().catch(() => {});
  const opts = { headless: process.env.AB_HEADED !== "1", viewport: { width: 1280, height: 900 } };
  if (process.env.AB_EPHEMERAL === "1") {
    browser = await ENGINE.launch({ headless: opts.headless });
    ctx = await browser.newContext({ viewport: opts.viewport });
  } else {
    // Each engine gets its own profile directory: they are not interchangeable on disk, and
    // pointing Firefox at a Chromium profile fails in ways that look like a bug in this tool.
    ctx = await ENGINE.launchPersistentContext(
      ENGINE_NAME === "chromium" ? PROFILE : `${PROFILE}-${ENGINE_NAME}`, opts);
  }
  page = ctx.pages()[0] || (await ctx.newPage());
  watch(page);
  ctx.on("page", (p) => { page = p; watch(p); }); // a link that opens a tab: follow it
  return page;
}

// Dialogs would block the page. Alerts are acknowledged. A confirm is how a page asks "are you
// sure?" before something destructive, so it is DISMISSED unless the click said confirm: true;
// either way the reply says what it asked.
const dialogs = [];
let acceptNextConfirm = false;
export const takeDialogs = () => dialogs.splice(0).map((d) => `a ${d.type} said: "${d.message}" (${d.outcome})`);

/** Append to a bounded log, dropping the oldest. An unbounded one grows for the whole session. */
function push(log, kind, entry) {
  log.push(entry);
  if (log.length > LOG_CAP[kind]) log.splice(0, log.length - LOG_CAP[kind]);
}

function watch(p) {
  p.on("dialog", async (d) => {
    const type = d.type();
    const accept = type === "alert" || type === "beforeunload" || (type === "confirm" && acceptNextConfirm);
    if (type === "confirm") acceptNextConfirm = false;
    dialogs.push({ type, message: d.message().slice(0, 200), outcome: accept ? "accepted" : "dismissed; click again with confirm: true to accept it" });
    await (accept ? d.accept() : d.dismiss()).catch(() => {});
  });
  // lastReq, not just the counter: a request cancelled by a navigation fires neither
  // requestfinished nor requestfailed, so `inflight` leaks upward and never returns to 0 -
  // measured, after a settle() keyed on `inflight === 0` hit its cap on every page including
  // example.com. A timestamp cannot leak.
  p.on("request", () => { inflight++; reqCount++; lastReq = Date.now(); });
  const done = () => { inflight = Math.max(0, inflight - 1); };
  p.on("requestfinished", done);
  p.on("requestfailed", done);
  // CONSOLE AND NETWORK, the two things a page will not tell you through the DOM. A tracker that
  // fires, a 500 on an XHR and a thrown error are all invisible to a snapshot: the Apollo pixel on
  // trade-guard.pro was only provable from the network log, because it is injected after hydration
  // and leaves nothing in the served HTML.
  p.on("console", (m) => {
    const type = m.type();
    if (type !== "error" && type !== "warning" && type !== "log") return;
    push(consoleLog, "console", { type, text: m.text().slice(0, 300), at: Date.now() });
  });
  p.on("pageerror", (e) => push(consoleLog, "console", { type: "pageerror", text: String(e.message || e).split("\n")[0].slice(0, 300), at: Date.now() }));
  // Logged when the request is MADE, then updated with its outcome.
  //
  // Recording only on response/requestfailed made a request that had not finished invisible, which
  // hides the two cases you most want to see: a call still hanging, and a tracker whose DNS is
  // slow. It also made the test for third-party requests flaky, because whether the cross-origin
  // fetch had failed yet by the time the page settled was a race.
  p.on("response", (r) => {
    const e = netIndex.get(r.request());
    if (e) e.status = r.status();
  });
  p.on("requestfailed", (r) => {
    const e = netIndex.get(r);
    if (e) { e.status = 0; e.failure = (r.failure()?.errorText || "failed").slice(0, 80); }
  });
  // A new document means a new page's worth of errors; keeping the old ones makes a clean page
  // look broken. Only the main frame counts - an iframe navigating is not a new page.
  //
  // CLEARED WHEN THE NAVIGATION IS REQUESTED, not on framenavigated. framenavigated fires after
  // the new document has committed, which is after its OWN response event, so clearing there
  // deleted the main document's entry - the log read "no requests recorded for this page" on a
  // page that had just served one. Caught by using this on trade-guard.pro while it was 502ing:
  // the 502 itself had vanished from the log.
  p.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === p.mainFrame()) { consoleLog = []; netLog = []; }
    const e = { url: r.url().slice(0, 300), method: r.method(), status: null, type: r.resourceType(), at: Date.now() };
    netIndex.set(r, e);
    push(netLog, "network", e);
  });
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
  const out = render(await p.evaluate(collect, opts), opts);
  // Asking for the page in full resets what "changed" is measured against, so an explicit
  // snapshot always tells the whole truth and the next diff is honest about the same baseline.
  if (!opts.find && !opts.scope) lastSnap = out;
  return out;
}

/**
 * Wait until the page is usable, which is NOT the same as networkidle.
 *
 * networkidle needs 500ms with no requests at all, so a page that polls, beacons analytics or
 * holds a socket open never reaches it and burns the whole timeout every single navigation.
 * Measured 2026-09-24: the boss dashboard finishes domcontentloaded in 116ms and then waits the
 * full 4000ms for a silence that never arrives - a 34x tax - and docs.stripe.com does the same.
 * Two of four real pages timed out; the two that did not still paid 500-1500ms, because 500ms of
 * enforced silence is networkidle's floor by definition.
 *
 * So ask the two questions that actually decide whether a page can be driven: has the DOM
 * stopped changing, and is anything still in flight. Both signals already exist (__abMut is set
 * by a MutationObserver in the init script, inflight by the request hooks above). Returns as soon
 * as they agree, rather than waiting out a clock.
 */
async function settle(p, ms = 2000) {
  await p.waitForLoadState("domcontentloaded", { timeout: ms }).catch(() => {});
  const start = Date.now(), end = start + ms;
  // A GATE BEFORE THE EARLY EXIT CAN FIRE. Straight after first paint there is a window where the
  // DOM is quiet and nothing has been requested yet, because the page's own script has not run its
  // fetches. Exiting there returns a shell: the boss dashboard came back reading "Scanning ~ ..."
  // with every data card still empty.
  //
  // This used to be a flat 400ms wait, and that turned out to be the binding constraint on most
  // pages rather than the page itself: measured 2026-09-25, settle exited at 426-430ms on three of
  // four real pages — the floor plus one poll tick — while the page had been ready earlier.
  //
  // So the gate now opens on the SIGNAL rather than the clock: once the page has issued a request
  // of its own since navigation, its script is demonstrably running and the quiet checks below can
  // be trusted. The 150ms is only a backstop for a page that never fetches anything at all.
  //
  // Verified to change the waiting and not the answer: identical snapshots on five live pages, and
  // on the boss dashboard — the page this floor was written for — it is both faster (2370ms ->
  // 1400ms) and MORE consistent, returning the same 2605 characters on every run where the old
  // floor returned 2578/2603/2605 and so was sometimes catching the page mid-render.
  const FLOOR = 150;
  const reqAtStart = reqCount;
  while (Date.now() < end) {
    const elapsed = Date.now() - start;
    if (elapsed < FLOOR && reqCount === reqAtStart) { await p.waitForTimeout(40); continue; }
    const quiet = await p.evaluate(() => Date.now() - (window.__abMut || 0)).catch(() => 9999);
    // 250ms since the last DOM change AND since the last request STARTED. Both are timestamps,
    // so neither can get stuck the way a counter does; a page with a heartbeat settles between
    // beats instead of never settling at all.
    if (quiet >= 250 && Date.now() - lastReq >= 250) return;
    await p.waitForTimeout(40);
  }
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
    const visible = [];
    for (let i = 0; i < Math.min(n, 8); i++) if (await c.nth(i).isVisible().catch(() => false)) visible.push(c.nth(i));
    if (!visible.length) continue;
    // FIRST-MATCH-WINS WAS SILENTLY WRONG. On Google Groups "Create group" is both the sidebar
    // button and the wizard's submit; taking the first one reopened the sidebar instead of
    // creating the group, and nothing in the reply said a choice had been made. Still act on the
    // first (usually right, and stopping would be worse), but record it so the reply can say so.
    if (visible.length > 1) {
      const where = await Promise.all(visible.slice(0, 4).map(async (v) => {
        const d = await describe(v).catch(() => "element");
        const box = await v.boundingBox().catch(() => null);
        return box ? `${d} at ${Math.round(box.x)},${Math.round(box.y)}` : d;
      }));
      lastAmbiguity = `${visible.length} visible elements match ${JSON.stringify(t)} - used the first. Others: ${where.slice(1).join("; ")}. Pass a snapshot ref (e12) to be exact.`;
    }
    return visible[0];
  }
  return null;
}

// Set by locate() when a target was ambiguous; drained by whatever acted, so the reply can admit
// that it picked one of several rather than leaving the caller to find out from the result.
let lastAmbiguity = null;
export const takeAmbiguity = () => { const a = lastAmbiguity; lastAmbiguity = null; return a; };

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

// The last snapshot we handed back, so the next one can say what CHANGED instead of repeating it.
// Reset on navigation, where "changed" stops being meaningful.
let lastSnap = null;
let diffsOn = true;
/** Turn diff replies off (the benchmark measures both routes; callers who want every reply in full). */
export function setDiffs(on) { diffsOn = !!on; lastSnap = null; }

/**
 * What an action returns: what happened, then the page.
 *
 * THE PAGE IS SENT AS A DIFF WHERE THAT IS HONEST, and this is the single biggest saving in real
 * use. A page costs ~3,000 characters; a ten-step task used to cost ten of those, even though
 * steps two through ten mostly re-sent what step one already said. Clicking "Next" in a wizard
 * changes a handful of lines and repeats sixty.
 *
 * So after an action on the SAME page, only the added, removed and changed lines go back, with a
 * count of what held still. The full snapshot is still sent when it is the honest answer: on a new
 * URL, when there is nothing to compare against, or when more than half the page moved — past that
 * point a diff is both longer and harder to read than simply saying what is there now.
 *
 * Refs survive a re-render (they live on the element), which is what makes the comparison mean
 * something: a line that is "unchanged" really is the same element, not a coincidence of text.
 */
function diffSnap(prev, next) {
  if (!prev) return { text: next, full: true };
  const line = (l) => l.trim();
  const prevLines = prev.split("\n").map(line);
  const nextLines = next.split("\n").map(line);
  const prevSet = new Set(prevLines);
  const nextSet = new Set(nextLines);
  const added = nextLines.filter((l) => l && !prevSet.has(l));
  const gone = prevLines.filter((l) => l && !nextSet.has(l));
  const held = nextLines.filter((l) => l && nextSet.has(l) && prevSet.has(l)).length;
  if (!added.length && !gone.length) return { text: `the page is unchanged (${held} elements)`, full: false };
  // More than half the page moved: a diff stops being the shorter or clearer answer.
  if (added.length + gone.length > held) return { text: next, full: true };
  const body = [
    `changed: +${added.length} -${gone.length}, ${held} unchanged`,
    ...added.slice(0, 30).map((l) => `+ ${l}`),
    ...gone.slice(0, 10).map((l) => `- ${l}`),
  ];
  if (added.length > 30) body.push(`… ${added.length - 30} more added (ask for a snapshot to see all)`);
  return { text: body.join("\n"), full: false };
}

async function after(p, before, notes, { snap = true } = {}) {
  await settle(p, 3000);
  const out = [...notes, ...takeDialogs()];
  const moved = p.url() !== before;
  if (moved) out.push(`now at ${p.url()}`);
  if (snap) {
    // THE BASELINE IS TAKEN BEFORE THE FRESH SNAPSHOT, because snapshot() updates lastSnap itself.
    // Reading it afterwards compared the page against a copy of itself and answered "the page is
    // unchanged" to every action, however much had moved -- a wrong answer that was also short,
    // so it looked like a saving in the benchmark right up until a test asked what it actually said.
    const baseline = lastSnap;
    const fresh = await snapshot({ limit: 40 });
    // A new document is a new page; there is nothing meaningful to diff against.
    const d = moved || !diffsOn ? { text: fresh, full: true } : diffSnap(baseline, fresh);
    lastSnap = fresh;
    out.push("", d.text);
  }
  return out.join("\n");
}

export async function click(target, opts = {}) {
  const p = await session();
  acceptNextConfirm = !!opts.confirm;
  const loc = await locate(target);
  if (!loc) return `no visible element matches ${JSON.stringify(target)}\n\n${await snapshot({ find: /^e\d+$/.test(target) ? "" : String(target).split(/\s+/).pop(), limit: 20 })}`;
  const what = await describe(loc);
  const ambiguous = takeAmbiguity();
  if (await loc.isDisabled().catch(() => false)) return `${what} is disabled`;
  const notes = await clearPath(p, loc);
  if (ambiguous) notes.push(ambiguous);
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

/**
 * Type into one field, or into many in a single call.
 *
 * `fields` is the reason this exists. A six-field form used to cost six MCP round-trips, and the
 * round-trip - model turn, transport, tool dispatch - dwarfs the typing. Filling them in one call
 * turns a sign-up form from six exchanges into one. Each field is still located and cleared
 * individually, so a batch behaves exactly like the single calls it replaces; the only thing
 * removed is the waiting in between.
 *
 * A field that cannot be found does not abort the rest: the reply names which ones missed, so a
 * partly-filled form can be finished rather than started over.
 */
export async function fill(target, value, { submit = false, fields = null } = {}) {
  const p = await session();

  if (Array.isArray(fields) && fields.length) {
    const done = [], missed = [];
    for (const f of fields) {
      const loc = await locate(f.target).catch(() => null);
      if (!loc) { missed.push(f.target); continue; }
      await clearPath(p, loc);
      await loc.fill(String(f.value ?? "")).catch(() => missed.push(f.target));
      done.push(await describe(loc));
    }
    const lines = [];
    if (done.length) lines.push(`filled ${done.length}: ${done.join(", ")}`);
    if (missed.length) lines.push(`no visible field matched: ${missed.map((m) => JSON.stringify(m)).join(", ")}`);
    if (!submit) return lines.join("\n") || "nothing to fill";
    const before = p.url();
    const last = done.length ? await locate(fields[fields.length - 1].target).catch(() => null) : null;
    if (last) await last.press("Enter");
    return after(p, before, [...lines, "pressed Enter"]);
  }

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
  const p = await session();
  const loc = await locate(target);
  if (!loc) return `no visible dropdown matches ${JSON.stringify(target)}`;
  const native = await loc.evaluate((el) => el.tagName === "SELECT").catch(() => false);
  if (native) {
    const picked = await loc.selectOption({ label: option }).catch(() => loc.selectOption(option)).catch((e) => e);
    return picked instanceof Error
      ? `could not pick ${JSON.stringify(option)}: ${picked.message.split("\n")[0]}`
      : `picked ${JSON.stringify(option)} in ${await describe(loc)}`;
  }
  // NOT A <select>, WHICH IS THE COMMON CASE ON A REAL APP. Material, Angular and every design
  // system build dropdowns from [role=listbox]/[role=combobox] with [role=option] children, and
  // selectOption throws "Element is not a <select> element" on all of them - hit on Google Groups,
  // where picking "Anyone can join" took a click on the box and a click on the option.
  await loc.click({ timeout: 5000 }).catch(() => {});
  const opt = p.getByRole("option", { name: option, exact: false });
  const n = await opt.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 8); i++) {
    const cand = opt.nth(i);
    if (!(await cand.isVisible().catch(() => false))) continue;
    await cand.click({ timeout: 5000 }).catch(() => {});
    // Confirm from the page, not from the click landing: aria-selected is the dropdown's own
    // answer, and a click that looked fine but did not register is the failure mode that matters.
    const ok = await cand.evaluate((el) => el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true").catch(() => false);
    return `picked ${JSON.stringify(option)} in ${await describe(loc)}${ok ? "" : " (the option did not report itself selected - check with a snapshot)"}`;
  }
  const names = await opt.evaluateAll((els) => els.slice(0, 8).map((e) => e.innerText.trim().slice(0, 40))).catch(() => []);
  return `no option matching ${JSON.stringify(option)} appeared after opening ${await describe(loc)}${names.length ? `. Options offered: ${names.join(", ")}` : ""}`;
}

/** Attach local files to a file input (or the input behind an "Upload" button). */
export async function upload(target, paths) {
  const p = await session();
  let loc = await locate(target);
  if (!loc) return `no visible element matches ${JSON.stringify(target)}`;
  const isFile = await loc.evaluate((el) => el.tagName === "INPUT" && el.type === "file").catch(() => false);
  if (!isFile) {
    // a styled button: the real input is usually hidden next to it, or opens a chooser on click
    const chooser = p.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
    await loc.click().catch(() => {});
    const fc = await chooser;
    if (!fc) return `${await describe(loc)} is not a file input and didn't open a file chooser`;
    await fc.setFiles(paths);
  } else {
    await loc.setInputFiles(paths);
  }
  await settle(p, 3000);
  return `attached ${paths.map((x) => x.split("/").pop()).join(", ")}`;
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

/**
 * A picture the model can actually SEE, in one call.
 *
 * The old version wrote a PNG and returned "saved /tmp/x.png", which is not seeing anything: the
 * agent then had to read the file back, so every look at a page cost two round-trips and the
 * caller had to invent a path it did not want. Now the image comes back inline and `path` is
 * optional, for when a file is genuinely wanted (a report, a diff against a later shot).
 *
 * JPEG rather than PNG because the job is reading a layout, not archiving pixels: q72 is visually
 * the same at reading size and roughly a fifth of the bytes of the PNG.
 */
export async function screenshot(path, { full = false } = {}) {
  const p = await session();
  const buf = await p.screenshot({ fullPage: full, type: "jpeg", quality: 72 });
  if (path) await writeFile(path, buf).catch(() => {});
  return {
    image: buf.toString("base64"),
    mime: "image/jpeg",
    note: `${full ? "full page" : "viewport"}, ${Math.round(buf.length / 1024)} KB${path ? `, also saved to ${path}` : ""}`,
  };
}

/**
 * The console, which is where a page admits what went wrong. `level` narrows to
 * "error" (errors and uncaught exceptions only) or a substring to match.
 */
export async function consoleMessages({ level, limit = 40 } = {}) {
  await session();
  let rows = consoleLog;
  if (level === "error") rows = rows.filter((r) => r.type === "error" || r.type === "pageerror");
  else if (level) rows = rows.filter((r) => r.type === level || r.text.toLowerCase().includes(String(level).toLowerCase()));
  if (!rows.length) return consoleLog.length ? `no console messages match; ${consoleLog.length} in total on this page` : "the console is clean on this page";
  const shown = rows.slice(-limit);
  const head = `${rows.length} console message${rows.length === 1 ? "" : "s"}${rows.length > shown.length ? `, last ${shown.length}` : ""}:`;
  return [head, ...shown.map((r) => `  [${r.type}] ${r.text}`)].join("\n");
}

/**
 * The network log. `failed` keeps only failures and 4xx/5xx; `thirdParty` keeps only requests to a
 * different registrable domain than the page (how you catch a tracker the page never mentions);
 * `match` is a substring of the URL.
 */
export async function network({ failed = false, thirdParty = false, match, limit = 40 } = {}) {
  const p = await session();
  const host = await p.evaluate(() => location.hostname).catch(() => "");
  // Compare the last two labels, so cdn.example.com counts as the same site as example.com but
  // aplo-evnt.com does not. Good enough without shipping a public-suffix list.
  const site = (h) => h.split(".").slice(-2).join(".");
  let rows = netLog;
  if (failed) rows = rows.filter((r) => r.status === 0 || (r.status !== null && r.status >= 400));
  if (thirdParty) rows = rows.filter((r) => { try { return site(new URL(r.url).hostname) !== site(host); } catch { return false; } });
  if (match) rows = rows.filter((r) => r.url.toLowerCase().includes(String(match).toLowerCase()));
  if (!rows.length) return netLog.length ? `no requests match; ${netLog.length} on this page` : "no requests recorded for this page";
  const shown = rows.slice(-limit);
  const head = `${rows.length} request${rows.length === 1 ? "" : "s"}${rows.length > shown.length ? `, last ${shown.length}` : ""}:`;
  const line = (r) => `  ${r.failure ? "FAILED" : r.status === null ? "pending" : r.status} ${r.method} ${r.type === "document" ? "" : r.type + " "}${r.url}${r.failure ? ` (${r.failure})` : ""}`;
  // Third-party domains summarised too: the question is usually "who else is this page talking to",
  // and a list of 40 URLs answers it worse than a list of hosts.
  const hosts = [...new Set(shown.map((r) => { try { return new URL(r.url).hostname; } catch { return "?"; } }))];
  const tail = hosts.length > 1 ? [`hosts: ${hosts.join(", ")}`] : [];
  return [head, ...shown.map(line), ...tail].join("\n");
}

export async function js(code) {
  const p = await session();
  const v = await p.evaluate(code).catch((e) => `error: ${e.message.split("\n")[0]}`);
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s ?? "undefined").slice(0, 4000);
}
