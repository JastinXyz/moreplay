import { mkdirSync, writeFileSync } from "node:fs";
// Usage: node spike/e2e.mjs '<json array of [tool, args]>' — runs the calls in one server session.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["../dist/index.js"], cwd: "spike", env: process.env }));
for (const [name, args] of JSON.parse(process.argv[2])) {
  const t0 = performance.now();
  const r = await client.callTool({ name, arguments: args });
  mkdirSync("spike/evidence", { recursive: true });
  // Images are written next to the evidence so they can be opened; the log shows their path.
  const shown = r.content.map((c, i) => {
    if (c.type !== "image") return c.text;
    const file = `spike/evidence/e2e-${name}-${Date.now()}-${i}.jpg`;
    writeFileSync(file, Buffer.from(c.data, "base64"));
    return `[image ${Math.round((c.data.length * 3) / 4 / 1024)} KB -> ${file}]`;
  });
  console.log(`## ${name} ${args.action ?? ""} ${Math.round(performance.now() - t0)}ms${r.isError ? " ERROR" : ""}\n${shown.join("\n")}\n`);
}
await client.close();
