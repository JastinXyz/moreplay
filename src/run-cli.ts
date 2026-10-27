import { relative, resolve } from "node:path";
import { Device } from "./device.js";
import { EVIDENCE_DIR, FLOWS_DIR, fromCompact, loadFlow, runFlow } from "./flow.js";
import { Reporter, useColor } from "./report.js";

/** `droidreplay run <flow> [--var k=v]... [--evidence dir]`: replays a flow with no model involved. */
export async function runCli(args: string[]): Promise<number> {
  const vars: Record<string, string> = {};
  let target: string | undefined;
  let evidenceDir = resolve(EVIDENCE_DIR);
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
    } else if (a === "--evidence") {
      const dir = args[++i];
      if (!dir) {
        console.error("--evidence needs a folder");
        return 2;
      }
      evidenceDir = resolve(dir);
    } else if (!target) {
      target = a;
    } else {
      console.error(`unexpected argument: ${a}`);
      return 2;
    }
  }
  if (!target) {
    console.error("usage: droidreplay run <flow name or .yaml path> [--var key=value]... [--evidence dir]");
    return 2;
  }

  const device = new Device();
  try {
    const { path, flow } = await loadFlow(resolve(FLOWS_DIR), target);
    // Labels come from the flow as written, so ${secrets} are not printed.
    const near = (p: string) => (relative(process.cwd(), p).startsWith("..") ? p : relative(process.cwd(), p) || p);
    const rep = new Reporter(flow.steps.map(fromCompact), useColor(process.stdout));
    console.log(rep.header(near(path)));
    const result = await runFlow(device, flow, { vars, evidenceDir, onStep: (i, r) => console.log(rep.step(i, r)) });
    if (result.failedStep) for (const l of rep.notRun(result.failedStep)) console.log(l);
    const evidence = result.shots ? near(result.evidenceDir) : undefined;
    console.log(rep.footer(result.ok, result.secs, { failedStep: result.failedStep, evidence }));
    return result.ok ? 0 : 1;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  } finally {
    device.stop();
  }
}
