# agent-browser

A browser an agent can actually drive, as an MCP tool set over Playwright.

**Measured against what Playwright's own MCP server sends a model, on five live pages: 37.6x smaller
and 1.4x faster.** One Wikipedia article is 246,434 characters there and 4,557 here. Run
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
/plugin marketplace add rebel-studios/agent-browser
/plugin install agent-browser
```

The first run fetches the Chromium build Playwright drives, once, and says so on stderr (never on
stdout, which is the protocol channel).

## What it fixes

Each row is a thing that cost us time first, then got a tool.

| Friction | What it does instead |
| --- | --- |
| Whole-page accessibility dumps flood the context | `snapshot`/`open` return a compact outline: headings, forms and dialogs as groups, each interactive element as `[e12] button "Next" (disabled)`, navigation and footers collapsed to six links and a count, then 400 characters of page text. Measured 37.6x smaller than the snapshot Playwright's MCP server sends (1.5x to 54.1x per page); `npm run bench` reproduces it. |
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

Also: `fill`, `upload` (file inputs, or an Upload button that opens a chooser), `press`, `back`,
`js` (the escape hatch), `close`. Dialogs never block a page silently: alerts are acknowledged, a
confirm is dismissed unless the click passed `confirm: true`, and the reply quotes what either said.

## Why `network` earns its place

A tracking script injected after hydration leaves **nothing** in the served HTML. We shipped a
privacy policy saying "no third-party tracking pixels" onto a site that was firing one on every
page load, and `curl` plus a source grep agreed with the policy both times. The network log is what
settled it, and it is what settled that the fix had worked.

Source tells you what a page might do. The network log tells you what it did.

## Notes

- One persistent profile at `~/.cache/agent-browser/profile`, so a login made once survives.
  `AB_EPHEMERAL=1` uses a throwaway context; `AB_HEADED=1` shows the window.
- `AB_PROFILE` and `AB_CREDS` move the profile and the credentials file.
- Replies name elements by their label, never by a field's value — a value can be a secret.
- `bin/attach.mjs` connects over CDP to a browser you are already signed into, for the case where
  logging in is not something to automate. It opens its own page and never navigates your tabs.
- `npm test` runs the fixtures in `test/`: compactness, stable refs, forms, secrets, overlays, the
  three wait states, ambiguous targets, ARIA dropdowns, console, network, and the MCP protocol.

## Limits, so they are not a surprise

- Chromium only. Firefox and WebKit are not wired up.
- One page at a time. A link that opens a tab is followed; there is no tab switcher.
- `snapshot` describes interactive elements and headings. It is not a reader for prose-heavy pages —
  use `js` for that.
- `network` starts recording when the server starts driving, so it has nothing from before that.

## What it will not do

It does not try to defeat bot protection. A Cloudflare interstitial, a block page or a rate-limit
notice is **reported** so you know what you are looking at, and the way through is to be a browser
you are genuinely signed in to (`bin/attach.mjs`) or to use the site's API. Dressing up as something
else is a race that gets lost on the next update, and it breaks the terms of most sites worth
visiting.

## Licence

MIT. See [LICENSE](LICENSE).
