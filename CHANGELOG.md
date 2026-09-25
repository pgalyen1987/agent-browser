# Changelog

Every entry says what was wrong, because that is the useful half. Numbers are from
`npm run bench` on the day, against the snapshot Playwright's MCP server sends.

## 0.6.1

- **WebKit runs on distros that are not Ubuntu 24.04.** `npx playwright install-deps webkit`
  apt-gets Ubuntu package names that do not exist on Kali or Debian testing (`libicu74`,
  `libjpeg-turbo8`). `bin/webkit-deps.mjs` fetches just the shared objects WebKit actually links and
  puts them in the bundle's own lib directory — no sudo, nothing outside `~/.cache`. Symlinking a
  newer ICU does not work: its symbols carry the major version, so the library loads and every
  symbol is missing. All 25 browser tests now pass on WebKit, so all three engines are verified.
- The first version of that installer probed `WebKitWebProcess`, which does not link ICU —
  `MiniBrowser` does — so it reported "nothing to do" about a WebKit that could not start. Its
  verdict is now a real launch rather than an `ldd` listing.

## 0.6.0

- **`read`**: the page as prose with the navigation stripped, in slices for a long page. "Not a
  reader" had been a gap with a workaround (the `js` escape hatch) rather than a feature. `find`
  returns a window **centred** on the phrase; snapping to a fixed slice grid cut the match in half
  whenever it straddled a boundary.
- **`downloads({ waitSeconds })`**: a download lands after the click returns, so asking immediately
  usually found nothing.
- **`AB_CDP` finally has a test**, which was overdue — it is the answer to every site that refuses
  an automated browser, and it had shipped untested because it was built last.

## 0.5.1

- `solve` cannot beat Cloudflare's strict mode and now says so. Measured on claude.ai: 170 seconds
  of a person clicking, headed, and again with the real Google Chrome binary — still challenged.
  Telling someone to try again wastes another three minutes on something that cannot work, so it
  names what is happening and gives the instruction that does (`AB_CDP`).
- `AB_CHANNEL=chrome` uses the installed Google Chrome rather than Playwright's build. Worth having
  for fidelity; measured, it makes no difference to bot protection, and the README says so.

## 0.5.0

- **`solve`**: reopens a blocked page in a visible window and waits while the person at the keyboard
  clears the challenge. A CAPTCHA asks whether a human is present; if one is, they can answer it.
  The persistent profile keeps the cookie, so later runs go through headless. It refuses honestly
  when it cannot help rather than wasting someone's time.

## 0.4.3

- A bot wall named only in the page **title** is caught. Cloudflare's interstitial on claude.ai puts
  "Just a moment..." in the title and only "Performing security verification" in the body, so a
  body-only check read it as an ordinary page. Third miss from this detector, all found by hitting
  them during real work.

## 0.4.1

- A politely worded CAPTCHA is still a wall. DuckDuckGo answers a suspected bot with "bots use
  DuckDuckGo too… select all squares", which matched none of the shipped phrasings — so it
  snapshotted as an ordinary page and an empty search read as "no matches".

## 0.4.0

- **iframes**: child frames are collected, refs prefixed `[f1e3]`, cross-origin frames named as
  unreadable rather than dropped. This was the worst gap because it was silent — a card form or a
  consent dialog made the page look *empty* rather than look wrong.
- **tabs**: list, switch by index or URL, close one. A link that opened a tab used to be a dead end.
- **downloads**: saved to disk and listed. The browser discards them unless something asks, so
  "Export CSV" did nothing at all.
- **`AB_CDP`**: attaches the whole server to a browser already running and signed in. `close`
  detaches instead of shutting it down.
- **Firefox**: `AB_BROWSER=firefox`, its own profile directory, whole suite passing.
- Diff replies after an action (`changed: +2 -2, 17 unchanged`). Measured: 1.7x cheaper across a
  click-heavy task and **nothing at all** on form filling, because `fill` already answers in twenty
  characters. `bench/session.mjs` prints both; a benchmark that only shows the flattering task is
  not one.
- The diff had a bug caught by writing its test: the baseline was read *after* the fresh snapshot had
  overwritten it, so every action answered "the page is unchanged" however much had moved.
- `npm test` was exiting 1 while every assertion passed — the smoke file needed longer than the
  script's 60s timeout.
- **37.2x → 44.3x smaller**, by deleting waste rather than showing less: the word "link" was 12.4% of
  every snapshot (88 of 103 elements on Wikipedia), and the prose tail duplicated headings the page
  had already given.

## 0.2.1

- `package.json` still said `"license": "SEE LICENSE IN LICENSE"` after the core went MIT, so npm
  advertised a bespoke licence for an MIT project. That is the field people filter on.
- The launcher re-installed 96 packages it already had: it looked for `<root>/node_modules/<pkg>`,
  but npm hoists dependencies to the installing project's top level.

## 0.2.0

- First public release. Compact snapshots, stable refs, overlay-proof clicks, three-state `wait`,
  `fill_secret`, ARIA dropdowns, ambiguity reporting, `console` and `network`, inline `screenshot`,
  bot-wall naming, and the benchmark.
- **The benchmark was measuring the wrong thing and undersold the product by half.**
  `ariaSnapshot()` is not what Playwright's MCP server sends — it omits the `[ref=e1]` annotations
  MCP adds, which are most of the bytes. Against the real format the ratio was 37.6x, not 19.9x.
