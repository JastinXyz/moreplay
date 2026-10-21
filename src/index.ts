#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Device, type StepResult } from "./device.js";

const device = new Device();
const evidenceDir = resolve(process.env.DROIDREPLAY_EVIDENCE_DIR ?? join(process.cwd(), "evidence"));

// Ops handled on the laptop side; everything else goes to the on-device agent in one request.
const HOST_OPS = new Set(["launch", "stop_app", "apps", "screenshot"]);

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
  async ({ steps, observe_after }) => {
    const lines: string[] = [];
    let failed = false;
    let pending: object[] = [];

    const flush = async () => {
      if (!pending.length) return;
      const r = await device.run(pending, true);
      pending = [];
      for (const s of r.results) lines.push(fmt(s));
      failed = !r.ok;
    };

    for (const step of steps) {
      if (failed) break;
      if (!HOST_OPS.has(step.op)) {
        pending.push(step);
        continue;
      }
      await flush();
      if (failed) break;
      const t0 = Date.now();
      try {
        lines.push(fmt({ op: step.op, ok: true, ms: 0, out: await hostOp(step) }, Date.now() - t0));
      } catch (e) {
        lines.push(fmt({ op: step.op, ok: false, ms: 0, error: (e as Error).message }, Date.now() - t0));
        failed = true;
      }
    }
    await flush();

    if (observe_after !== false && steps[steps.length - 1].op !== "observe") {
      const r = await device.run([{ op: "wait_idle", quietMs: 250, timeout: 2000 }, { op: "observe" }]);
      lines.push("--- screen", r.results[1]?.out ?? "");
    }
    return text(lines.join("\n"));
  },
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
    const path = await saveScreenshot(name);
    if (!show) return text(path);
    const img = await device.screenshot(1024, 70);
    return { content: [{ type: "text" as const, text: path }, { type: "image" as const, data: img.toString("base64"), mimeType: "image/jpeg" }] };
  },
);

function fmt(s: StepResult, ms = s.ms): string {
  const body = (s.ok ? s.out : s.error) ?? "";
  // Multi-line output (observe) goes below the status line.
  return body.includes("\n") ? `${s.ok ? "✓" : "✗"} ${s.op} ${ms}ms\n${body.trimEnd()}` : `${s.ok ? "✓" : "✗"} ${s.op} ${ms}ms ${body}`;
}

async function hostOp(step: Record<string, unknown>): Promise<string> {
  const pkg = String(step.package ?? "");
  switch (step.op) {
    case "launch": {
      if (!pkg) throw new Error("launch needs package");
      const activity = (await device.shell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg} | tail -1`)).trim();
      if (!activity.includes("/")) throw new Error(`no launchable activity for ${pkg} (installed? see apps)`);
      await device.shell(`am start -n ${activity}`);
      return `launched ${activity}`;
    }
    case "stop_app":
      await device.shell(`am force-stop ${pkg}`);
      return `stopped ${pkg}`;
    case "apps": {
      const filter = String(step.filter ?? "").toLowerCase();
      const out = await device.shell("pm list packages -3");
      const pkgs = out.split("\n").map((l) => l.replace("package:", "").trim()).filter((p) => p && p.includes(filter));
      return pkgs.sort().join(" ");
    }
    case "screenshot":
      return `saved ${await saveScreenshot(step.name as string | undefined)}`;
  }
  throw new Error(`unknown op ${step.op}`);
}

async function saveScreenshot(name?: string): Promise<string> {
  const img = await device.screenshot(0, 85);
  const safe = (name ?? new Date().toISOString().replace(/[:.]/g, "-")).replace(/[^\w.-]+/g, "_");
  await mkdir(evidenceDir, { recursive: true });
  const path = join(evidenceDir, safe.endsWith(".jpg") ? safe : `${safe}.jpg`);
  await writeFile(path, img);
  return path;
}

process.on("exit", () => device.stop());
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
// MCP clients usually just close our stdin when they are done.
process.stdin.on("close", () => process.exit(0));

await server.connect(new StdioServerTransport());
