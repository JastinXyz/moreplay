#!/usr/bin/env node
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAct, saveScreenshot } from "./act.js";
import { Device } from "./device.js";

const device = new Device();
const evidenceDir = resolve(process.env.DROIDREPLAY_EVIDENCE_DIR ?? join(process.cwd(), "evidence"));

const server = new McpServer({ name: "droidreplay", version: "0.1.0" });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

server.registerTool(
  "observe",
  {
    description:
      "Current screen as one line per element: `@ref Class \"label\" #id [x,y] flags`. Use refs/text/id from here in `act`.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const r = await device.run([{ op: "observe" }]);
    return text(r.results[0].out ?? r.results[0].error ?? "");
  },
);

server.registerTool(
  "act",
  {
    description: [
      "Run steps in order in ONE call; batch everything you can. Stops at the first failure. Returns the screen afterwards.",
      "Target (tap/long_press/type/wait_*): ref | x,y | text (also matches content-desc; exact, else contains) | id | desc.",
      "Ops: tap, long_press{ms}, type{value, field?=label of field, submit?, append?} (no target = focused field),",
      "scroll{dir:down|up|left|right, until?:{text|id|desc}, max?}, swipe{x1,y1,x2,y2,ms?}, key{key:back|home|enter|recents|delete|tab|<keycode>},",
      "wait_for{target, timeout?=5000}, wait_gone{target, timeout?}, wait_idle{quietMs?=300, timeout?}, sleep{ms},",
      "launch{package}, stop_app{package}, apps{filter?}, screenshot{name} (saved as evidence file, not shown), observe.",
    ].join("\n"),
    inputSchema: {
      steps: z.array(z.object({ op: z.string() }).passthrough()).min(1),
      observe_after: z.boolean().optional().describe("default true"),
    },
  },
  async ({ steps, observe_after }) => text(await runAct(device, steps, { observeAfter: observe_after, evidenceDir })),
);

server.registerTool(
  "screenshot",
  {
    description: "Save a JPEG of the screen to the evidence folder and return its path. Set show=true only to look at it yourself.",
    inputSchema: {
      name: z.string().optional().describe("file name, e.g. TC-03-login-ok"),
      show: z.boolean().optional(),
    },
  },
  async ({ name, show }) => {
    const path = await saveScreenshot(device, evidenceDir, name);
    if (!show) return text(path);
    const img = await device.screenshot(1024, 70);
    return { content: [{ type: "text" as const, text: path }, { type: "image" as const, data: img.toString("base64"), mimeType: "image/jpeg" }] };
  },
);

process.on("exit", () => device.stop());
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
// MCP clients usually just close our stdin when they are done.
process.stdin.on("close", () => process.exit(0));

await server.connect(new StdioServerTransport());
