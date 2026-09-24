#!/usr/bin/env node
// agent-browser: an MCP server that drives Chromium for an agent. Every answer is a compact snapshot
// or a sentence about what happened, never a whole-page accessibility dump.
//
//   claude mcp add agent-browser -- node ~/agent-browser/src/server.mjs
//
// AB_HEADED=1 shows the window; AB_EPHEMERAL=1 skips the saved profile (~/.cache/agent-browser).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as b from "./browser.mjs";

const server = new McpServer({ name: "agent-browser", version: "0.1.0" });
const text = (s) => ({ content: [{ type: "text", text: String(s) }] });
const safe = (fn) => async (args) => {
  try { return text(await fn(args || {})); } catch (e) { return { ...text(`error: ${String(e.message || e).split("\n")[0]}`), isError: true }; }
};
const target = z.string().describe('A ref from a snapshot ("e12") or a description: \'button "Next"\', \'link Pricing\', a field label, or visible text');

server.registerTool("open", {
  description: "Go to a URL and return a compact snapshot: headings, forms and interactive elements with refs (e1, e2...), then a short run of the page text. Flags login pages and overlays.",
  inputSchema: { url: z.string() },
}, safe(({ url }) => b.open(url)));

server.registerTool("snapshot", {
  description: "The current page as a compact snapshot. Narrow it with find (text to match in labels) or scope (a ref or CSS selector); limit caps the elements (default 60).",
  inputSchema: { find: z.string().optional(), scope: z.string().optional(), limit: z.number().int().optional(), withText: z.boolean().optional() },
}, safe((o) => b.snapshot(o)));

server.registerTool("click", {
  description: "Click an element. Scrolls to it, and if an overlay (cookie bar, chat widget, sticky footer) covers it, dismisses or hides that first and says so. Returns what changed and a fresh snapshot.",
  inputSchema: { target, snap: z.boolean().optional().describe("include the snapshot after (default true)"), confirm: z.boolean().optional().describe("accept an \"are you sure?\" confirm this click raises (dismissed by default)") },
}, safe(({ target: t, snap, confirm }) => b.click(t, { snap: snap !== false, confirm })));

server.registerTool("fill", {
  description: "Type into a field, or fill a whole form in ONE call with `fields`. Prefer `fields` for anything with more than one input: six separate calls cost six round-trips, and the round-trip is the slow part, not the typing. submit presses Enter after the last field.",
  inputSchema: {
    target: target.optional(),
    value: z.string().optional(),
    fields: z.array(z.object({
      target: z.string().describe("a ref like e12, or a description like 'textbox \"Email\"'"),
      value: z.string(),
    })).optional().describe("fill many fields in one call, in order"),
    submit: z.boolean().optional(),
  },
}, safe(({ target: t, value, submit, fields }) => b.fill(t, value, { submit, fields })));

server.registerTool("fill_secret", {
  description: "Type a credential into a field by its NAME in ~/.config/rebel-studios/creds.env (e.g. STRIPE_SECRET_KEY). The value never appears in this conversation; later snapshots show the field as (secret).",
  inputSchema: { target, key: z.string() },
}, safe(({ target: t, key }) => b.fillSecret(t, key)));

server.registerTool("select", {
  description: "Pick an option in a select, by its visible label (or value).",
  inputSchema: { target, option: z.string() },
}, safe(({ target: t, option }) => b.select(t, option)));

server.registerTool("upload", {
  description: "Attach local file(s) to a file input, or to an Upload button that opens a file chooser.",
  inputSchema: { target, paths: z.array(z.string()).min(1) },
}, safe(({ target: t, paths }) => b.upload(t, paths)));

server.registerTool("press", {
  description: "Press a key on the page (Enter, Escape, Tab, ArrowDown, Control+A...).",
  inputSchema: { key: z.string() },
}, safe(({ key }) => b.press(key)));

server.registerTool("wait", {
  description: "Wait for an element or text to appear (or with gone, to disappear). If it times out, says whether the page is still loading or has gone idle without it, so absent and slow are never confused.",
  inputSchema: { target, gone: z.boolean().optional(), seconds: z.number().optional() },
}, safe(({ target: t, gone, seconds }) => b.wait(t, { gone, timeout: (seconds || 10) * 1000 })));

server.registerTool("next", {
  description: "Press the page's forward button (Next, Continue, Submit, Done...), preferring one inside a form or dialog. For wizards. Lists the page's buttons if there is none.",
  inputSchema: {},
}, safe(() => b.next()));

server.registerTool("back", { description: "Go back one page.", inputSchema: {} }, safe(() => b.back()));

server.registerTool("screenshot", {
  description: "Save a PNG of the page to a path (full: the whole scroll height).",
  inputSchema: { path: z.string(), full: z.boolean().optional() },
}, safe(({ path, full }) => b.screenshot(path, { full })));

server.registerTool("js", {
  description: "Evaluate a JavaScript expression in the page and return the result (trimmed). The escape hatch.",
  inputSchema: { code: z.string() },
}, safe(({ code }) => b.js(code)));

server.registerTool("close", { description: "Close the browser (the saved profile stays).", inputSchema: {} }, safe(async () => { await b.close(); return "closed"; }));

await server.connect(new StdioServerTransport());
