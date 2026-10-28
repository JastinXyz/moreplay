import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Listing tools never touches a device, so this runs in CI.
test("exposes 4 tools and keeps their definitions small", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["act", "flow", "observe", "screenshot"]);
    const shot = tools.find((t) => t.name === "screenshot");
    assert.ok(shot.inputSchema.properties.refs, "screenshot takes refs for icon crops");
    // Tool definitions are re-sent with every request; a budget keeps them from creeping up.
    const chars = JSON.stringify(tools).length;
    assert.ok(chars < 3600, `tool definitions grew to ${chars} chars (~${Math.round(chars / 4)} tokens)`);
  } finally {
    await client.close();
  }
});

// show and patch never touch a device either.
test("flow show and patch take a .yaml path outside the flows folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "droidreplay-"));
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [resolve("dist/index.js")], cwd: dir }));
  try {
    const path = join(dir, "scratch", "login.yaml");
    await mkdir(join(dir, "scratch"));
    await writeFile(path, "name: login\nsteps:\n  - tap: A\n  - tap: B\n");
    const shown = await client.callTool({ name: "flow", arguments: { action: "show", name: path } });
    assert.match(shown.content[0].text, /tap: B/);
    const patched = await client.callTool({ name: "flow", arguments: { action: "patch", name: path, index: 2, steps: [{ tap: "C" }] } });
    assert.ok(!patched.isError, patched.content[0].text);
    assert.match(await readFile(path, "utf8"), /tap: C/);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("act refuses a ${var} it has no value for, before touching a device", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
  try {
    const r = await client.callTool({ name: "act", arguments: { steps: [{ op: "type", value: "${PIN}" }] } });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /missing variable\(s\): PIN/);
  } finally {
    await client.close();
  }
});
