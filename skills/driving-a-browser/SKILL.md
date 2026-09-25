---
name: driving-a-browser
description: How to drive a web page you did not write - read it cheaply, click things that work, fill forms and credentials, and find out why a page is misbehaving from its console and network log. Use whenever a task means opening, reading, clicking or filling a real web page, checking what a live site actually serves, or proving what a page does at runtime rather than reading its source.
---

# Driving a browser

Playwright was built to test pages you wrote, where you know the selectors. An agent is working
pages it has never seen. These tools are shaped for the second case.

## Read the page before acting on it

`open <url>` and `snapshot` return a compact outline, not a whole-page accessibility dump:
headings, forms and dialogs as groups, each interactive element as `[e12] button "Next" (disabled)`,
navigation and footers collapsed to a few links and a count, then a short run of page text.

Every element carries a ref (`e12`) that is stored on the element itself, so it survives a
re-render for as long as the element exists. **Prefer a ref over a description** once you have one:
a description can match more than one thing.

Narrow instead of paging through everything: `snapshot find:"Email"` or `snapshot scope:e4`.

## Acting

- `click` scrolls to the target and, if a cookie bar or chat bubble covers it, dismisses that
  first and tells you which. If several visible elements match the target it acts on the first and
  **says so** — when you see that note, redo it with a ref.
- `fill` takes a `fields` array. Use it. A six-field form in one call is one round-trip instead of
  six, and the round-trip is the slow part.
- `fill_secret` takes a key NAME from the credentials file, never a value. The secret reaches the
  page and not the transcript; later snapshots show the field as `(secret)`.
- `select` handles a real `<select>` and an ARIA listbox/combobox (`[role=option]`), which is what
  most design systems actually ship.
- `next` presses the page's forward button, for wizards.
- A confirm dialog ("are you sure?") is **dismissed** unless the click passed `confirm: true`.

## When a page will not behave

Three tools answer three different questions, and picking the right one saves a lot of guessing:

- `wait` distinguishes **there** from **still loading** from **absent on a settled page**. "Not
  found" and "not loaded yet" look identical otherwise.
- `console` is what the page admits: errors, warnings, uncaught exceptions. `level:"error"` for
  errors and thrown exceptions only.
- `network` is what the page actually did. `failed:true` for failures and 4xx/5xx. `thirdParty:true`
  for requests leaving the page's own domain — this is how you catch a tracker the page does not
  mention. `match:"..."` for a substring of the URL.

Both are scoped to the current page and reset when you navigate.

## Proving what a page does

**Source is not proof.** A component can sit in a bundle without firing, and a script injected after
hydration leaves nothing in the served HTML — so `curl` and a source grep will both come back clean
on a page that is definitely running the thing you are looking for.

Drive the page and read `network`. That is the proof. A grep of the HTML is a fast first signal and
nothing more.

## Seeing it

`screenshot` returns the image itself, so looking at a page is one call. Pass `full: true` for the
whole scroll height, and `path` only when you want a file kept as well.

Use it when the question is visual — is this laid out correctly, does this look finished, what is
actually on screen — and use `snapshot` when the question is structural. A snapshot is far cheaper;
reach for the picture when the words are not enough.
