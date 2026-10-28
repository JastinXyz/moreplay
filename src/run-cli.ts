import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { Device } from "./device.js";
import { collectFlows, EVIDENCE_DIR, FLOWS_DIR, fromCompact, loadFlow, pickByTags, runFlow, type FlowFile } from "./flow.js";
import { junitXml, Reporter, suiteSummary, useColor, type FlowReport } from "./report.js";

const USAGE =
  "usage: droidreplay run <flow name, .yaml path or folder>... [--var key=value]... [--evidence dir]\n" +
  "                       [--include-tags a,b] [--exclude-tags c] [--junit report.xml]";

const tagList = (v: string) => v.split(",").map((t) => t.trim()).filter(Boolean);

/**
 * `droidreplay run <flow|folder>... [--var k=v]... [--evidence dir] [--include-tags a,b]
 * [--exclude-tags c]`: replays flows with no model involved, one after another on one agent.
 * Exit 0 when every flow that ran passed, 1 when one failed (or none matched), 2 on bad usage.
 */
export async function runCli(args: string[]): Promise<number> {
  const vars: Record<string, string> = {};
  const targets: string[] = [];
  let evidenceDir = resolve(EVIDENCE_DIR);
  let include: string[] = [];
  let exclude: string[] = [];
  let junit: string | undefined;
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
    } else if (a === "--evidence" || a === "--include-tags" || a === "--exclude-tags" || a === "--junit") {
      const v = args[++i];
      if (!v) {
        console.error(`${a} needs a value`);
        return 2;
      }
      if (a === "--evidence") evidenceDir = resolve(v);
      else if (a === "--include-tags") include = tagList(v);
      else if (a === "--junit") junit = resolve(v);
      else exclude = tagList(v);
    } else if (a.startsWith("--")) {
      console.error(`unknown option: ${a}`);
      return 2;
    } else {
      targets.push(a);
    }
  }
  if (!targets.length) {
    console.error(USAGE);
    return 2;
  }

  const color = useColor(process.stdout);
  const near = (p: string) => (relative(process.cwd(), p).startsWith("..") ? p : relative(process.cwd(), p) || p);
  let flows: { path: string; flow: FlowFile }[];
  try {
    const paths = await collectFlows(targets, resolve(FLOWS_DIR));
    flows = await Promise.all(paths.map((p) => loadFlow(resolve(FLOWS_DIR), p)));
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const { run, skipped } = pickByTags(flows, include, exclude);
  if (!run.length) {
    console.error(`no flows to run (${flows.length} found, ${skipped.length} skipped by tags)`);
    return 1;
  }

  const device = new Device();
  const t0 = Date.now();
  const results: FlowReport[] = [];
  try {
    for (const { path, flow } of run) {
      // Labels come from the flow as written, so ${secrets} are not printed.
      const rep = new Reporter(flow.steps.map(fromCompact), color);
      console.log(rep.header(near(path)));
      try {
        const result = await runFlow(device, flow, { vars, evidenceDir, dir: dirname(path), onStep: (i, r) => console.log(rep.step(i, r)) });
        // Step lines print as they arrive, before a crash is known; show it once the flow stops.
        if (result.crash) console.log(result.crash.split("\n").map((l) => `      ${l}`).join("\n"));
        if (result.failedStep) for (const l of rep.notRun(result.failedStep)) console.log(l);
        const evidence = result.shots ? near(result.evidenceDir) : undefined;
        console.log(rep.footer(result.ok, result.secs, { failedStep: result.failedStep, evidence }));
        results.push({
          file: near(path),
          name: flow.name,
          ok: result.ok,
          secs: Number(result.secs),
          failedStep: result.failedStep,
          error: result.error,
          crash: result.crash,
          artifacts: result.artifacts?.map(near),
        });
      } catch (e) {
        // A flow that cannot start (a missing ${var}, no device) fails; the rest still run.
        console.log(`  ${(e as Error).message}`);
        results.push({ file: near(path), name: flow.name, ok: false, secs: 0, error: (e as Error).message });
      }
    }
  } finally {
    device.stop();
  }
  const secs = (Date.now() - t0) / 1000;
  if (run.length > 1 || skipped.length) {
    console.log(suiteSummary(results.map((r) => ({ name: r.file, ok: r.ok, failedStep: r.failedStep })), skipped.length, secs.toFixed(1), color));
  }
  if (junit) {
    await mkdir(dirname(junit), { recursive: true });
    await writeFile(junit, junitXml(results, skipped.map((f) => ({ file: near(f.path), name: f.flow.name })), secs));
    console.log(`JUnit  ${near(junit)}`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}
