// The server speaks MCP over stdio: tools list, and a call returns text.
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("tools are listed and open/click answer in text", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../src/server.mjs")], env: { ...process.env, AB_EPHEMERAL: "1" } });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    for (const t of ["open", "snapshot", "click", "fill", "fill_secret", "wait", "next", "js"]) assert.ok(tools.some((x) => x.name === t), t);
    const url = pathToFileURL(join(import.meta.dirname, "fixtures/overlay.html")).href;
    const opened = await client.callTool({ name: "open", arguments: { url } });
    assert.match(opened.content[0].text, /button "Continue to payment"/);
    const clicked = await client.callTool({ name: "click", arguments: { target: 'button "Continue to payment"', snap: false } });
    console.log(clicked.content[0].text);
    assert.match(clicked.content[0].text, /clicked button "Continue to payment"/);
  } finally {
    await client.callTool({ name: "close", arguments: {} }).catch(() => {});
    await client.close();
  }
});
