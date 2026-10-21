import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "bench", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, DROIDREPLAY_EVIDENCE_DIR: "spike/evidence" } }));
const time = async (label, name, args) => { const t0 = performance.now(); const r = await client.callTool({ name, arguments: args }); const txt = r.content.filter((c) => c.type === "text").map((c) => c.text).join(""); console.log(`${label} ${Math.round(performance.now() - t0)}ms ${txt.length}B`); };
await time("observe (cold, starts agent)", "observe", {});
for (let i = 0; i < 5; i++) await time("observe", "observe", {});

for (let i = 0; i < 3; i++) await time("screenshot to file", "screenshot", { name: "bench" });
await client.close();
