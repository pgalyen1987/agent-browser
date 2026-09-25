#!/usr/bin/env node
// The entry point a plugin install points at.
//
// WHY A LAUNCHER AND NOT src/server.mjs DIRECTLY. Installing a plugin copies files; it does not run
// npm install. So a fresh install has no node_modules, and pointing the MCP config straight at the
// server means the first thing a buyer sees is "Cannot find package '@modelcontextprotocol/sdk'"
// with no hint of what to do. Install friction is what kills a tool nobody has used yet.
//
// So: check the dependencies, fetch them once if they are missing, then hand over to the server.
//
// EVERYTHING HERE WRITES TO STDERR. stdout is the MCP protocol channel - a single stray line of
// npm output on it makes the client fail to parse the handshake and the server looks broken.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const say = (s) => process.stderr.write(`agent-browser: ${s}\n`);

// Checked by presence of the two packages that must resolve, not of node_modules itself: a partial
// or interrupted install leaves the directory there and the packages missing.
const needed = ["@modelcontextprotocol/sdk", "playwright"];
const missing = needed.filter((p) => !existsSync(join(root, "node_modules", p)));

if (missing.length) {
  say(`first run: installing ${missing.join(", ")}`);
  const npm = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: root,
    // CHILD STDOUT GOES TO FD 2, NOT "inherit". "inherit" hands the child our stdout, which is the
    // MCP protocol channel: npm's "added 96 packages in 642ms" landed on it and the client could
    // not parse the handshake. Caught by piping a real initialize through a clean copy.
    stdio: ["ignore", 2, 2],
    env: { ...process.env, npm_config_loglevel: "error" },
  });
  if (npm.status !== 0) {
    say(`could not install dependencies. Run this once by hand:\n    cd ${root} && npm install`);
    process.exit(1);
  }
}

// Playwright needs its browser binary too, and its absence is a different error with a different
// fix, so it gets its own message rather than being lumped in with the packages above.
try {
  const { chromium } = await import("playwright");
  const path = chromium.executablePath();
  if (!existsSync(path)) {
    say("installing the Chromium build Playwright drives (one time, a few hundred MB)");
    const r = spawnSync("npx", ["playwright", "install", "chromium"], {
      cwd: root,
      stdio: ["ignore", 2, 2], // as above: never the protocol channel
    });
    if (r.status !== 0) say(`could not install Chromium. Run: cd ${root} && npx playwright install chromium`);
  }
} catch (e) {
  say(`playwright did not load: ${e.message}`);
}

await import("../src/server.mjs");
