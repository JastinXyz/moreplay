import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Listing tools never touches a device, so this runs in CI.
test("exposes 3 tools and keeps their definitions small", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["act", "observe", "screenshot"]);
    // Tool definitions are re-sent with every request; a budget keeps them from creeping up.
    const chars = JSON.stringify(tools).length;
    assert.ok(chars < 2500, `tool definitions grew to ${chars} chars (~${Math.round(chars / 4)} tokens)`);
  } finally {
    await client.close();
  }
});
