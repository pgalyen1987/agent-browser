# agent-browser

A browser layer for AI agents, over Playwright, served as an MCP tool set. Internal tooling: it
exists to cut the tokens and round-trips our own sessions spend driving web pages. Playwright was
built to test pages you wrote; an agent is working pages it has never seen.

    claude mcp add agent-browser -- node ~/agent-browser/src/server.mjs

## What it fixes (measured friction, in the order it cost us)

| Friction | What the tools do instead |
| --- | --- |
| Whole-page accessibility dumps flood the context | `snapshot`/`open` return a compact outline: headings, forms and dialogs as groups, each interactive element as `[e12] button "Next" (disabled)`, navigation and footers collapsed to six links and a count, then 400 characters of page text. 3x to 18x smaller than Playwright's aria snapshot on real pages (18x on the Daybreak leaderboard). |
| Element refs go stale after a re-render | Refs are stored on the element (`data-ab`), so a button keeps `e12` across snapshots while it exists. Targets can also be `'button "Next"'` or a label. |
| Cookie bars and chat bubbles intercept clicks | `click` scrolls to the target, checks what is actually on top of it, presses the overlay's Accept/Close/Got it button or hides the layer, and says which. |
| "Not found" and "not loaded yet" look the same | `wait` answers one of three things: there; still loading (requests in flight or the DOM changed in the last 800 ms); absent on a page that has gone idle. |
| Secrets pass through the transcript | `fill_secret` takes a key name from `~/.config/rebel-studios/creds.env`; the value goes to the page only, and later snapshots show the field as `(secret)`. |
| Auth expiry shows up as a redirect | Snapshots start with `auth: this looks like a login page` when the page is one. |
| Wizards need "Next" found by hand every step | `next` presses the page's forward button (Next, Continue, Submit, Done...), preferring one in a form or dialog. |

Other tools: `fill`, `select`, `upload` (file inputs, or an Upload button that opens a chooser), `press`, `back`, `screenshot`, `js` (the escape hatch), `close`. Alert/confirm dialogs are accepted and their text reported in the next reply, so they never block a page silently.

## Notes

- One persistent profile at `~/.cache/agent-browser/profile`, so a login made once survives.
  `AB_EPHEMERAL=1` uses a throwaway context; `AB_HEADED=1` shows the window.
- Replies name elements by their label, never by a field's value (a value can be a secret).
- `npm test` runs the fixtures in `test/` (compactness, stable refs, forms, secrets, overlays,
  the three wait states, the MCP protocol).
