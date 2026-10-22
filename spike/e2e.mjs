// Usage: node spike/e2e.mjs '<json array of [tool, args]>' — runs the calls in one server session.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, DROIDREPLAY_FLOWS_DIR: "spike/flows", DROIDREPLAY_EVIDENCE_DIR: "spike/evidence" } }));
for (const [name, args] of JSON.parse(process.argv[2])) {
  const t0 = performance.now();
  const r = await client.callTool({ name, arguments: args });
  console.log(`## ${name} ${args.action ?? ""} ${Math.round(performance.now() - t0)}ms${r.isError ? " ERROR" : ""}\n${r.content.map((c) => c.text).join("\n")}\n`);
}
await client.close();
