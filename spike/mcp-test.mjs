import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "test", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["../dist/index.js"], cwd: "spike", env: process.env }));
const tools = await client.listTools();
const defs = JSON.stringify(tools.tools);
console.log(`tools: ${tools.tools.map((t) => t.name).join(", ")} | defs ${defs.length} chars ≈ ${Math.round(defs.length / 4)} tokens`);

const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const out = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n## ${name} ${Date.now() - t0}ms, ${out.length} chars ≈ ${Math.round(out.length / 4)} tokens\n${out.slice(0, 1400)}`);
};

await call("observe");
await call("act", { steps: [
  { op: "launch", package: "com.miui.calculator" },
  { op: "wait_for", text: "AC", timeout: 4000 },
  { op: "tap", text: "7" }, { op: "tap", desc: "plus" }, { op: "tap", text: "5" }, { op: "tap", desc: "equals" },
  { op: "screenshot", name: "calc-7-plus-5" },
] });
await call("act", { steps: [{ op: "key", key: "home" }], observe_after: false });
await client.close();
