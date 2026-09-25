// Rat Race store-forms driver. Attaches to the shared browser, finds MY tab (by CDP target id
// stored in the scratchpad), runs a JS body from stdin with (page, ctx, h) in scope, then detaches.
// Never closes anything.
import { chromium } from "playwright";
import fs from "fs";
const STATE = "/tmp/claude-1000/-home-me/aee59c89-f938-46bd-af8b-cfab7b217a3a/scratchpad/tabs.json";
const [name = "play"] = process.argv.slice(2);
const b = await chromium.connectOverCDP("http://localhost:9224");
const ctx = b.contexts()[0];
async function tid(p) { const s = await ctx.newCDPSession(p); const { targetInfo } = await s.send("Target.getTargetInfo"); await s.detach(); return targetInfo.targetId; }
let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
let page;
if (st[name]) for (const p of ctx.pages()) { try { if ((await tid(p)) === st[name]) { page = p; break; } } catch {} }
if (!page) for (const p of ctx.pages()) { try { if ((await p.evaluate(() => sessionStorage.getItem("rr_agent"))) === name) { page = p; console.log("(re-bound by marker)"); break; } } catch {} }
if (!page) { page = await ctx.newPage(); console.log("(opened new tab for", name + ")"); }
st[name] = await tid(page); fs.writeFileSync(STATE, JSON.stringify(st));
try { await page.evaluate((n) => sessionStorage.setItem("rr_agent", n), name); } catch {}
const h = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  text: async (max = 6000) => (await page.evaluate(() => document.body ? document.body.innerText : "")).replace(/\n{2,}/g, "\n").slice(0, max),
  aria: async (sel = "body", max = 8000) => (await page.locator(sel).first().ariaSnapshot({ timeout: 15000 })).slice(0, max),
  answer: async (q, off) => {
    const ok = await page.evaluate(([q, off]) => {
      document.querySelectorAll('[data-rr]').forEach(e => e.removeAttribute('data-rr'));
      const vis = (e) => { const r = e.getBoundingClientRect(); const lab = e.closest('label, mat-radio-button, mat-checkbox, material-radio, material-checkbox') || e.parentElement; const r2 = lab.getBoundingClientRect(); return (r.width > 0 || r2.width > 0) && getComputedStyle(lab).visibility !== 'hidden'; };
      const inputs = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')].filter(vis);
      const qs = [...document.querySelectorAll('body *')].filter(e => e.textContent.includes(q) && ![...e.children].some(c => c.textContent.includes(q)));
      if (!qs.length) return false;
      const qq = qs[qs.length - 1];
      const i = inputs.findIndex(x => qq.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (i < 0 || !inputs[i + off]) return false;
      inputs[i + off].setAttribute('data-rr', '1');
      return true;
    }, [q, off]);
    if (!ok) throw new Error("question not found: " + q);
    await page.locator('[data-rr="1"]').check();
    await new Promise(r => setTimeout(r, 1500));
  },
  section: async (a, b) => { const t = await page.evaluate(() => document.body.innerText); const i = t.indexOf(a); return t.slice(i, b ? t.indexOf(b, i + 1) : i + 4000); },
  shot: async (n = "s") => { const p = `/tmp/claude-1000/-home-me/aee59c89-f938-46bd-af8b-cfab7b217a3a/scratchpad/shots/${n}.jpg`; await page.screenshot({ path: p, type: "jpeg", quality: 45, scale: "css", timeout: 20000 }); return p; },
};
const code = fs.readFileSync(0, "utf8");
const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
try {
  const r = await new AsyncFn("page", "ctx", "h", code)(page, ctx, h);
  if (r !== undefined) console.log(typeof r === "string" ? r : JSON.stringify(r, null, 1));
} catch (e) { console.log("ERR", String(e.message || e).slice(0, 3000)); }
console.log("[url]", page.url());
process.exit(0);
