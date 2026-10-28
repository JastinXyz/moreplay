import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAct, saveScreenshot } from "./act.js";
import { Device, VERSION } from "./device.js";
import { EVIDENCE_DIR, flowName, FLOWS_DIR, fromCompact, listFlows, loadFlow, loadSubflow, patchSteps, Recorder, runFlow, saveFlow, substitute } from "./flow.js";

/** Runs the MCP server on stdio until the client goes away. */
export async function startServer(): Promise<void> {
  const device = new Device();
  // Defaults only: the model can pass its own paths to screenshot and flow.
  const evidenceDir = resolve(EVIDENCE_DIR);
  const flowsDir = resolve(FLOWS_DIR);
  let recorder: Recorder | undefined;
  // Where `flow save` writes: the name or path given to `flow record`.
  let recordTarget = "";

  const server = new McpServer({ name: "moreplay", version: VERSION });

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
        "Run steps in order in ONE call; batch everything you can. Stops at the first failure (optional:true skips if missing). Returns the screen.",
        "Target (tap/long_press/type/wait_*): ref | x,y | text (also content-desc; exact, else contains; '/re/' = regex) | id | desc, + below/above/leftOf/rightOf/childOf/containsChild:<target>, index:n, checked/enabled/selected/focused:bool. x,y may be '50%'.",
        "Ops: tap, long_press{ms}, type{value, field?=its label, submit?, append?} (no target = focused),",
        "scroll{dir:down|up|left|right, until?:target, max?}, swipe{x1,y1,x2,y2,ms?}, key{key:back|home|enter|recents|delete|tab|<keycode>},",
        "wait_for{target, timeout?=5000}, wait_gone{target, timeout?}, wait_idle{quietMs?=300, timeout?}, sleep{ms},",
        "launch{package, args?:{k: v}}, stop_app{package}, clear_app{package} (wipes data), install_app{path, grant?}, uninstall_app{package},",
        "open_link{url, package?}, permissions{package, grant?:[CAMERA..]|'all', revoke?}, logs{package?, level?=W, since?=60s, lines?=50}, apps{filter?}, screenshot{name} (name or path; saved, not shown), observe, hide_keyboard,",
        "repeat{times? | while?:{visible|notVisible: target}, steps},",
        "run_flow{file? | steps?, vars?, when?:{visible|notVisible: target | true: '${!!X}'}}: subflow (file relative to the flow), skipped if when fails.",
      ].join("\n"),
      inputSchema: {
        steps: z.array(z.object({ op: z.string() }).passthrough()).min(1),
        observe_after: z.boolean().optional().describe("default true"),
      },
    },
    // ${var} in steps takes the values given to `flow record`; the recorder saves them as ${var} again.
    async ({ steps, observe_after }) =>
      text(
        await runAct(device, substitute(steps, recorder?.vars ?? {}), {
          observeAfter: observe_after,
          evidenceDir,
          onSuccess: recorder && ((s, r) => recorder!.add(s, r)),
          subflows: {
            load: loadSubflow,
            prepare: (raw, v) => substitute(raw.map(fromCompact), v),
            vars: recorder?.vars ?? {},
            dir: process.cwd(),
          },
        }),
      ),
  );

  server.registerTool(
    "screenshot",
    {
      description: "Save a JPEG of the screen and return its path. show=true to see it too.",
      inputSchema: {
        name: z.string().optional().describe("file name (evidence folder) or a path"),
        show: z.boolean().optional(),
        refs: z.array(z.number().int()).optional().describe("instead: small crops of these @refs (e.g. icon), nothing saved"),
      },
    },
    async ({ name, show, refs }) => {
      if (refs?.length) {
        const img = await device.crops(refs);
        return { content: [{ type: "text" as const, text: `crops of ${refs.map((r) => `@${r}`).join(" ")}, left to right` }, { type: "image" as const, data: img.toString("base64"), mimeType: "image/jpeg" }] };
      }
      const path = await saveScreenshot(device, evidenceDir, name);
      if (!show) return text(path);
      const img = await device.screenshot(1024, 70);
      return { content: [{ type: "text" as const, text: path }, { type: "image" as const, data: img.toString("base64"), mimeType: "image/jpeg" }] };
    },
  );

  server.registerTool(
    "flow",
    {
      description: [
        "Record once, replay without a model. name: flow name or .yaml path.",
        "record{name, vars?}: keep every successful act step (refs become stable selectors); ${var} in act takes vars, saved unexpanded. save / discard: end it.",
        "run{name, vars?, evidence?=dir}: replay; steps wait for their element.",
        "On failure: step number + screen; fix with patch{name, index, steps} (steps:[] deletes), run again.",
        "list, show{name}. Flow files may set dismiss:[text|{id}]: popups tapped away whenever they appear.",
      ].join("\n"),
      inputSchema: {
        action: z.enum(["record", "save", "discard", "run", "patch", "list", "show"]),
        name: z.string().optional(),
        vars: z.record(z.string(), z.string()).optional(),
        evidence: z.string().optional(),
        index: z.number().int().optional(),
        steps: z.array(z.record(z.string(), z.unknown())).optional(),
      },
    },
    async ({ action, name, vars, evidence, index, steps }) => {
      const need = (v: string | undefined) => {
        if (!v) throw new Error(`${action} needs name`);
        return v;
      };
      switch (action) {
        case "record":
          recordTarget = need(name);
          recorder = new Recorder(flowName(recordTarget), vars);
          return text(`recording ${recorder.name}: act steps that succeed are kept until flow save`);
        case "save": {
          if (!recorder) throw new Error("not recording (flow record first)");
          if (!recorder.steps.length) throw new Error("nothing recorded yet");
          const path = await saveFlow(flowsDir, recorder.toFile(), recordTarget);
          const n = recorder.steps.length;
          recorder = undefined;
          return text(`saved ${n} steps to ${path}`);
        }
        case "discard":
          recorder = undefined;
          return text("recording discarded");
        case "run": {
          const { path, flow } = await loadFlow(flowsDir, need(name));
          const out = evidence ? resolve(evidence) : evidenceDir;
          return text((await runFlow(device, flow, { vars, evidenceDir: out, dir: dirname(path), screenOnFailure: true })).text);
        }
        case "patch": {
          if (index === undefined || !steps) throw new Error("patch needs index and steps");
          const { path: src, flow } = await loadFlow(flowsDir, need(name));
          const path = await saveFlow(flowsDir, patchSteps(flow, index, steps), src);
          return text(`patched step ${index} of ${flow.name} (${path})`);
        }
        case "list": {
          const names = await listFlows(flowsDir);
          return text(names.length ? names.join("\n") : `no flows in ${flowsDir}`);
        }
        case "show": {
          const { path } = await loadFlow(flowsDir, need(name));
          return text(`${path}\n${await readFile(path, "utf8")}`);
        }
      }
    },
  );

  process.on("exit", () => device.stop());
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
  // MCP clients usually just close our stdin when they are done.
  process.stdin.on("close", () => process.exit(0));

  await server.connect(new StdioServerTransport());
}
