// The compact page snapshot. `collect` runs inside the page (Playwright serialises it), so it can
// only use what the browser has. It gives every interactive element a short ref (e1, e2, ...) kept
// on the element as data-ab, so the same button keeps its ref across snapshots as long as the page
// doesn't replace it, and a caller can click "e12" instead of re-finding it.
//
// Output is plain lines, ordered like the page:
//   # Heading
//   [e3] button "Sign in"
//   form "Login":
//     [e4] textbox "Email" (required) = "pat@example.com"
//   dialog "Cookie settings":
//     [e9] button "Accept all"
// then a short run of the main text. A whole-page accessibility dump is what this replaces.

export function collect({ limit = 60, find = "", scope = "", maxText = 400 } = {}) {
  const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="switch"], [role="combobox"], [role="option"], [contenteditable="true"]';
  const clean = (s, n = 80) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  const visible = (el) => {
    if (!el.isConnected) return false;
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      // opacity 0 is usually a scroll-reveal animation that hasn't run, or a styled checkbox's real
      // input; only a layer that also ignores the pointer is truly hidden
      if (Number(cs.opacity) === 0 && cs.pointerEvents === "none") return false;
    }
    return true;
  };
  const byId = (id) => { const x = document.getElementById(id); return x ? x.innerText || x.textContent : ""; };
  const label = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) return clean(by.split(/\s+/).map(byId).join(" "));
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return clean(l.innerText); }
    const wrap = el.closest("label");
    if (wrap && wrap !== el) {
      // a label wrapping its control also holds the control's own text (a select's options)
      const copy = wrap.cloneNode(true);
      copy.querySelectorAll("select, textarea, input, button").forEach((c) => c.remove());
      const t = clean(copy.textContent);
      if (t) return t;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && ["submit", "button", "reset"].includes(el.type)) return clean(el.value);
    if (tag === "img" || el.getAttribute("alt")) return clean(el.getAttribute("alt"));
    const own = clean(el.innerText || el.textContent);
    if (own) return own;
    return clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || (el.querySelector("img[alt]") || {}).alt || "");
  };
  const role = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "disclosure";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(t)) return "button";
      if (["checkbox", "radio", "password", "range", "file", "date", "time", "color"].includes(t)) return t;
      if (["email", "search", "number", "tel", "url"].includes(t)) return t;
      return "textbox";
    }
    return tag;
  };
  const state = (el) => {
    const out = [];
    const r = role(el);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out.push("disabled");
    if (el.required || el.getAttribute("aria-required") === "true") out.push("required");
    if (el.getAttribute("aria-expanded")) out.push(el.getAttribute("aria-expanded") === "true" ? "open" : "closed");
    if (r === "checkbox" || r === "radio" || r === "switch") out.push((el.checked || el.getAttribute("aria-checked") === "true") ? "on" : "off");
    if (el.getAttribute("aria-invalid") === "true" || (el.validity && el.value && !el.validity.valid)) out.push("invalid");
    let tail = out.length ? ` (${out.join(", ")})` : "";
    if (r === "select") {
      const o = el.options && el.options[el.selectedIndex];
      tail += ` = "${clean(o ? o.text : "", 40)}"`;
      if (el.options && el.options.length <= 8) tail += ` of [${[...el.options].map((x) => clean(x.text, 24)).join(" | ")}]`;
    } else if (el.dataset.abSecret) {
      tail += " = (secret)";
    } else if (r === "password") {
      if (el.value) tail += " = •••";
    } else if ("value" in el && typeof el.value === "string" && el.value && !["button", "link", "checkbox", "radio"].includes(r)) {
      tail += ` = "${clean(el.value, 40)}"`;
    }
    return tail;
  };
  window.__abN = window.__abN || 0;
  const ref = (el) => el.dataset.ab || (el.dataset.ab = "e" + ++window.__abN);

  const root = scope ? (document.querySelector(`[data-ab="${scope}"]`) || document.querySelector(scope) || document.body) : document.body;
  const container = (el) => el.closest('[role="dialog"], [aria-modal="true"], dialog[open], form, [role="form"]');
  const containerName = (c) => {
    const tag = c.tagName.toLowerCase();
    const kind = tag === "form" || c.getAttribute("role") === "form" ? "form" : "dialog";
    const heading = c.querySelector("h1, h2, h3, legend, [role=heading]");
    return `${kind} "${label(c) && (c.getAttribute("aria-label") || c.getAttribute("aria-labelledby")) ? label(c) : clean(heading ? heading.innerText : c.getAttribute("name") || c.id || "", 60)}"`;
  };
  const q = find.toLowerCase();
  const lines = [];
  let shown = 0, hidden = 0, currentBox = null;
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  const nodes = [...root.querySelectorAll(`h1, h2, h3, ${INTERACTIVE}`)];
  // over the limit: keep what's on screen and in main content, drop repeated nav/footer links
  const all = nodes.filter(visible);
  const interactive = all.filter((el) => !/^H[1-3]$/.test(el.tagName));
  // a site's navigation, header and footer are repeated on every page: a few links each, then a
  // count. The limit applies to the rest, keeping what's on screen and in main content.
  const REGION = "nav, header, footer, aside, [role=navigation], [role=contentinfo], [role=banner]";
  const content = interactive.filter((el) => !el.closest(REGION));
  let keep = new Set(content);
  if (!q && content.length > limit) {
    const score = (el) => (inView(el) ? 2 : 0) + (el.closest("main, [role=main], form, [role=dialog], dialog") ? 2 : 0);
    keep = new Set([...content].sort((a, b) => score(b) - score(a)).slice(0, limit));
  }
  const PER_REGION = 6;
  const regionSeen = new Map();
  const regionMore = new Map();
  for (const el of all) {
    const isHeading = /^H[1-3]$/.test(el.tagName);
    if (isHeading) {
      const t = clean(el.innerText, 100);
      if (!t || (q && !t.toLowerCase().includes(q))) continue;
      if (!q) lines.push(`${"#".repeat(Number(el.tagName[1]))} ${t}`);
      continue;
    }
    const name = label(el);
    if (q && !`${name} ${role(el)}`.toLowerCase().includes(q)) { hidden++; continue; }
    const region = !q && el.closest(REGION);
    if (region) {
      const n = (regionSeen.get(region) || 0) + 1;
      regionSeen.set(region, n);
      if (n > PER_REGION) { regionMore.set(region, (regionMore.get(region) || 0) + 1); continue; }
    } else if (!keep.has(el)) { hidden++; continue; }
    const box = container(el);
    if (box !== currentBox) {
      currentBox = box;
      if (box) lines.push(`${containerName(box)}:`);
    }
    // THE ROLE IS OMITTED FOR LINKS, which are the default and by far the commonest: 88 of 103
    // elements on the Wikipedia page and 60 of 60 on Hacker News. Spelling out "link" on each cost
    // 12.4% of the whole snapshot to repeat the least surprising fact on the page. Everything that
    // is NOT a plain link still names itself, which is the part that carries information.
    const r = role(el);
    lines.push(`${box ? "  " : ""}[${ref(el)}]${r === "link" ? "" : " " + r} "${name}"${state(el)}`);
    shown++;
    if (region && regionSeen.get(region) === PER_REGION) lines.push({ region }); // "… N more" goes here
  }
  for (let i = 0; i < lines.length; i++) {
    if (typeof lines[i] !== "object") continue;
    const more = regionMore.get(lines[i].region) || 0;
    const kind = lines[i].region.tagName.toLowerCase();
    lines[i] = more ? `  … ${more} more links in this ${["nav", "header", "footer", "aside"].includes(kind) ? kind : "navigation"}` : null;
  }
  const finalLines = lines.filter((l) => l !== null);
  // overlays that aren't marked up as dialogs: fixed layers covering a good part of the screen
  const overlays = [...document.querySelectorAll("body *")].filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") return false;
    const r = el.getBoundingClientRect();
    return visible(el) && r.width * r.height > innerWidth * innerHeight * 0.25 && !el.closest("header, nav") && !el.dataset.abHidden;
  }).slice(0, 2).map((el) => `overlay: "${clean(el.innerText, 80)}" covers ${Math.round((el.getBoundingClientRect().width * el.getBoundingClientRect().height * 100) / (innerWidth * innerHeight))}% of the screen`);

  const main = document.querySelector("main, [role=main], article") || document.body;
  // THE PROSE TAIL IS FOR ORIENTATION, and a page that already gives up a heading structure is
  // oriented by that instead — the Wikipedia snapshot carried 23 headings AND 400 characters of
  // prose saying much the same thing, at 13.9% of the payload. Pages with real headings get a
  // shorter tail; pages without one keep the full allowance, because there it is all they have.
  const headingCount = lines.filter((l) => typeof l === "string" && l.startsWith("#")).length;
  const text = clean(main.innerText, headingCount >= 4 ? Math.round(maxText * 0.4) : maxText);
  const pw = [...document.querySelectorAll('input[type="password"]')].some(visible);
  const signInWords = /\b(sign ?in|log ?in|login)\b/i;
  const h1 = document.querySelector("h1");
  const passwordish = pw && (signInWords.test(document.title) || signInWords.test(h1 ? h1.innerText : "") || content.length < 25);
  return {
    title: document.title,
    url: location.href,
    lines: finalLines,
    shown,
    hidden,
    overlays,
    text,
    loginLike: passwordish || /\/(log-?in|sign-?in|signin|auth|sso|oauth|session)(\/|\?|$)/i.test(location.pathname),
    // A BOT WALL IS NOT AN EMPTY PAGE, and it used to read exactly like one. Reddit answers a
    // blocked request with a styled page carrying almost no interactive elements, so the snapshot
    // came back looking like a site with nothing on it and the caller went hunting for a selector
    // that was never going to exist. Naming it costs one line and saves that whole detour.
    //
    // This REPORTS the wall, it does not get around it: the fix is to be a real signed-in browser
    // (attach to one you already use) or to use the site's API, not to dress up as something else.
    challenge: (() => {
      // THE TITLE COUNTS TOO. Cloudflare's interstitial on claude.ai puts "Just a moment..." in the
      // title and only "Performing security verification" in the body, so a body-only check read it
      // as an ordinary page — the third time this detector has been too literal about wording.
      const t = ((document.title || "") + "\n" + (document.body?.innerText || "")).slice(0, 3000);
      const hit = [
        [/just a moment|checking your browser|verifying you are human|verify you are human|performing security verification|security check to access/i, "an interstitial bot check"],
        [/blocked by network security|you have been blocked|access denied|request blocked/i, "a block page"],
        [/enable javascript and cookies to continue/i, "a bot check wanting JS and cookies"],
        [/unusual traffic|automated queries/i, "a rate-limit or automation notice"],
        // A CAPTCHA that asks politely still stops you. DuckDuckGo answers a suspected bot with
        // "Unfortunately, bots use DuckDuckGo too. Please complete the following challenge… Select
        // all squares containing a duck" — none of the phrasings above, so it snapshotted as an
        // ordinary page and the caller read an empty result as "no matches". Found by hitting it.
        [/complete the following challenge|was made by a human|select all (squares|images)|i'?m not a robot|are you a robot/i, "a CAPTCHA"],
        [/bots use .{0,24} too/i, "a CAPTCHA"],
      ].find(([re]) => re.test(t));
      if (!hit) return null;
      const vendor = /cloudflare|cf-chl|__cf/i.test(document.documentElement.innerHTML.slice(0, 20000))
        ? "Cloudflare" : /perimeterx|px-captcha/i.test(document.documentElement.innerHTML.slice(0, 20000))
        ? "PerimeterX" : /akamai|_abck/i.test(document.cookie) ? "Akamai" : null;
      return { kind: hit[1], vendor };
    })(),
  };
}

/** Render collect()'s result as the text an agent reads. */
export function render(s, { withText = true } = {}) {
  const head = [`${s.title || "(untitled)"} | ${s.url}`];
  if (s.loginLike) head.push("auth: this looks like a login page (session missing or expired?)");
  if (s.challenge)
    head.push(
      `blocked: this is ${s.challenge.kind}${s.challenge.vendor ? ` (${s.challenge.vendor})` : ""}, not the page you asked for. ` +
        `The elements below belong to the challenge. Use a browser you are already signed in to ` +
        `(cli/attach.mjs), or the site's API.`,
    );
  head.push(...s.overlays);
  const more = s.hidden ? [`… ${s.hidden} more interactive elements not shown (narrow with find: or scope:)`] : [];
  const body = s.lines.length ? s.lines : ["(no visible interactive elements)"];
  return [...head, "", ...body, ...more, ...(withText && s.text ? ["", `text: ${s.text}`] : [])].join("\n");
}
