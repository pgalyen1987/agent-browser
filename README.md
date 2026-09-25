# agent-browser

A browser an agent can actually drive, as an MCP tool set over Playwright.

[rebelstudiossoftware.com/agent-browser.html](https://rebelstudiossoftware.com/agent-browser.html)

**Measured against what Playwright's own MCP server sends a model, on five live pages: 44.3x smaller
and 1.7x faster.** One Wikipedia article is 241,988 characters there and 3,877 here. Run
`npm run bench` and check it yourself — that is what the benchmark is for.

Playwright was built to test pages you wrote, where you already know the selectors. An agent is
working pages it has never seen, and the friction is different: the page description is too big to
read, the element reference goes stale, a cookie bar eats the click, and "not found" is
indistinguishable from "not loaded yet".

## Install

It is an MCP server, so it is not tied to one model or one editor — any MCP client can run it.

```
claude mcp add agent-browser -- npx -y @rebelstudios/agent-browser
```

Any other MCP client: run `npx -y @rebelstudios/agent-browser` as a stdio server.

```json
{ "mcpServers": { "agent-browser": { "command": "npx", "args": ["-y", "@rebelstudios/agent-browser"] } } }
```

As a Claude Code plugin:

```
/plugin marketplace add pgalyen1987/agent-browser
/plugin install agent-browser
```

The first run fetches the Chromium build Playwright drives, once, and says so on stderr (never on
stdout, which is the protocol channel).

## What it fixes

Each row is a thing that cost us time first, then got a tool.

| Friction | What it does instead |
| --- | --- |
| Whole-page accessibility dumps flood the context | `snapshot`/`open` return a compact outline: headings, forms and dialogs as groups, each interactive element as `[e12] button "Next" (disabled)`, navigation and footers collapsed to six links and a count, then 400 characters of page text. Measured 44.3x smaller than the snapshot Playwright's MCP server sends (1.5x to 62.8x per page); `npm run bench` reproduces it. |
| Element refs go stale after a re-render | Refs live on the element (`data-ab`), so a button keeps `e12` across snapshots for as long as it exists. Targets can also be `'button "Next"'` or a field label. |
| Cookie bars and chat bubbles intercept clicks | `click` scrolls to the target, checks what is actually on top of it, presses the overlay's Accept/Close button or hides the layer, and says which. |
| Two things on the page share a name | `click` acts on the first and **says** it had a choice, with where the others are. Silence here is how a click meant for a wizard's submit button reopens a sidebar instead. |
| "Not found" and "not loaded yet" look the same | `wait` answers one of three things: there; still loading (requests in flight or the DOM changed in the last 800ms); absent on a page that has gone idle. |
| Secrets pass through the transcript | `fill_secret` takes a key NAME from a credentials file; the value reaches the page only, and later snapshots show the field as `(secret)`. |
| Dropdowns are not `<select>` any more | `select` drives a real `<select>` and an ARIA listbox/combobox, and confirms from `aria-selected` rather than from the click having landed. |
| Filling a form costs a round-trip per field | `fill` takes a `fields` array and does the whole form in one call. |
| A screenshot you cannot see | `screenshot` returns the image itself, so looking at a page is one call rather than save-then-read. |
| You cannot tell what a page really did | `console` gives its errors, warnings and uncaught exceptions. `network` gives its requests, with `failed`, `thirdParty` and `match` filters. Both scoped to the current page. |
| Auth expiry shows up as a redirect | Snapshots start with `auth: this looks like a login page` when the page is one. |
| A bot wall snapshots like an empty site | A challenge or block page is named — `blocked: this is an interstitial bot check (Cloudflare)` — instead of coming back as a page with nothing on it. It reports the wall; it does not get around one. |
| Wizards need "Next" found by hand every step | `next` presses the page's forward button, preferring one inside a form or dialog. |
| An iframe snapshots as nothing at all | Child frames are collected too and their refs prefixed — `[f1e3] button "Pay now"`. A card form, a consent dialog and an embedded editor are all iframes, so "the page looks empty" was a silent and common failure. A frame on another origin is named as unreadable rather than dropped. |
| A link opens a tab and there is no way back | `tabs` lists them (marking the one being driven), switches by index or URL substring, and closes one. |
| A download goes nowhere | The browser discards downloads unless something asks for them, so "Export CSV" appeared to do nothing. They save to disk and `downloads` lists them with their paths. |
| A bot wall is blocking a page you are allowed to see | `solve` reopens it in a **visible window** so you clear the challenge yourself, then carries on. The profile is persistent, so later runs go straight through headless. It asks the human who is already sitting there; it does not spoof anything. |
| You are signed in, but the tool is not | `AB_CDP=9224` drives a browser that is already running and already signed in, so every tool works against that session. Closing detaches instead of shutting their browser. |

Also: `fill`, `upload` (file inputs, or an Upload button that opens a chooser), `press`, `back`,
`js` (the escape hatch), `close`. Dialogs never block a page silently: alerts are acknowledged, a
confirm is dismissed unless the click passed `confirm: true`, and the reply quotes what either said.

## Why `network` earns its place

A tracking script injected after hydration leaves **nothing** in the served HTML. We shipped a
privacy policy saying "no third-party tracking pixels" onto a site that was firing one on every
page load, and `curl` plus a source grep agreed with the policy both times. The network log is what
settled it, and it is what settled that the fix had worked.

Source tells you what a page might do. The network log tells you what it did.

## How it compares, including where it loses

Against Playwright's MCP server — the default an agent is handed — it is **44.3x smaller** across
five live pages. That number is large because Playwright's format is verbose, not because this is
magic, so here is the closer comparison too.

**browser-use** already builds a compact representation and is far more widely adopted. Measured
the same day, its own `llm_representation()` on the same five pages totals **38,101 characters
against 11,397** — so about **3.3x**, and it **beats this tool on example.com** (138 vs 208), where
a page with almost nothing on it still costs us a header and a URL. `bench/browser-use.py`
reproduces that.

**Stagehand is not measured.** v4 depends on `@browserbasehq/sdk` and expects a paid Browserbase
account. An unmeasured competitor is left unmeasured rather than estimated.

## What a task costs, not just a page

After an action on the same page, only what changed comes back — `changed: +2 -2, 17 unchanged` and
the lines themselves — because clicking "Next" in a wizard moves a handful of lines and repeats
sixty. The full page is still sent when that is the honest answer: on a new URL, with nothing to
compare against, or when more than half the page moved.

Measured with `node bench/session.mjs`: **1.7x cheaper across the actions** of a click-heavy task.
On a form-filling task it saves **nothing at all**, because `fill` and `select` already answer in
twenty characters and never had the problem. Both numbers are in the benchmark.

## Notes

- One persistent profile at `~/.cache/agent-browser/profile`, so a login made once survives.
  `AB_EPHEMERAL=1` uses a throwaway context; `AB_HEADED=1` shows the window.
- `AB_PROFILE` and `AB_CREDS` move the profile and the credentials file.
- Replies name elements by their label, never by a field's value — a value can be a secret.
- `AB_CDP=9224` (a port or a full URL) attaches to a browser already running with
  `--remote-debugging-port=9224`, for the case where logging in is not something to automate: 2FA
  makes it impossible and doing it on someone's behalf is not the job. It opens its own page, never
  navigates theirs, and `close` detaches rather than shutting their browser. `bin/attach.mjs` does
  the same for one-off scripts outside the MCP.
- `AB_DOWNLOADS` moves where downloads land (default `~/.cache/agent-browser/downloads`).
- `AB_CHANNEL=chrome` uses the installed Google Chrome instead of the Chromium build Playwright
  ships — closer to what a visitor really runs. It does not get you past strict bot protection;
  measured, it makes no difference there.
- `npm test` runs the fixtures in `test/`: compactness, stable refs, forms, secrets, overlays, the
  three wait states, ambiguous targets, ARIA dropdowns, console, network, and the MCP protocol.

## Limits, so they are not a surprise

- WebKit is not tested. Chromium and Firefox are; `AB_BROWSER=firefox` switches engine, and the
  whole browser suite passes on both.
- Frames are collected up to eight deep in document order; an ad-heavy page with dozens is capped.
- `snapshot` describes interactive elements and headings. It is not a reader for prose-heavy pages —
  use `js` for that.
- `network` starts recording when the server starts driving, so it has nothing from before that.

## What it will not do

It does not try to defeat bot protection, and it will not be made to. A Cloudflare interstitial, a
block page or a rate-limit notice is **reported** so you know what you are looking at.

There are two honest ways through, and which one you need depends on how hard the site is refusing.

`solve` reopens the page in a visible window and waits while **you** clear the challenge. A CAPTCHA
asks whether a human is present; if one is, they can answer it themselves, and the persistent
profile keeps the cookie so later runs go straight through. This handles ordinary CAPTCHAs.

**It does not handle Cloudflare's strict mode**, and that is worth knowing before you spend three
minutes on it. Some sites — claude.ai among them, measured — reject a Playwright-driven browser on
sight and loop the challenge forever, headed or not, with Playwright's Chromium or the real Google
Chrome binary. No amount of clicking clears it, because the question is not being asked of you.

For those, the answer is a browser **this tool did not launch**: start Chrome yourself with
`--remote-debugging-port=9224`, then run with `AB_CDP=9224`. The site has already cleared that
session, so there is nothing to solve. `solve` says so rather than letting you keep clicking.

What it will not do is *pretend*: spoofing a fingerprint is a race lost on the next update, it
breaks the terms of most sites worth visiting, and it is the fastest way to get a tool delisted. Dressing up as something
else is a race that gets lost on the next update, and it breaks the terms of most sites worth
visiting.

## Licence and responsibility

MIT. See [LICENSE](LICENSE).

It depends on Playwright, the Model Context Protocol SDK and Zod, each licensed separately by its
own authors, and Playwright downloads browser builds from Microsoft under their terms. None of that
is affected by this licence.

It drives a real browser and acts on real websites on your behalf, so you are responsible for what
you point it at: the terms of the sites you visit, the accounts you sign into, and the credentials
you make available to it.
