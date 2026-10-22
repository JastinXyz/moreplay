import { join, resolve } from "node:path";
import { Device } from "./device.js";
import { loadFlow, runFlow } from "./flow.js";

/** `droidreplay run <flow> [--var k=v]...`: replays a flow with no model involved. */
export async function runCli(args: string[]): Promise<number> {
  const vars: Record<string, string> = {};
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--var") {
      const kv = args[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq < 1) {
        console.error(`--var needs key=value, got: ${kv}`);
        return 2;
      }
      vars[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (!target) {
      target = a;
    } else {
      console.error(`unexpected argument: ${a}`);
      return 2;
    }
  }
  if (!target) {
    console.error("usage: droidreplay run <flow name or .yaml path> [--var key=value]...");
    return 2;
  }

  const flowsDir = resolve(process.env.DROIDREPLAY_FLOWS_DIR ?? join(process.cwd(), "flows"));
  const evidenceDir = resolve(process.env.DROIDREPLAY_EVIDENCE_DIR ?? join(process.cwd(), "evidence"));
  const device = new Device();
  try {
    const { flow } = await loadFlow(flowsDir, target);
    const result = await runFlow(device, flow, { vars, evidenceDir });
    console.log(result.text);
    return result.ok ? 0 : 1;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  } finally {
    device.stop();
  }
}
