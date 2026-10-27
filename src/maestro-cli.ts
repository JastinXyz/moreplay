import { access, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { FLOWS_DIR, flowPath, loadFlow, safeFlowName, saveFlow } from "./flow.js";
import { fromMaestro, toMaestro } from "./maestro.js";

/** Splits `--key value` options from positional args; returns null on a flag with no value. */
function parseArgs(args: string[], known: string[]): { pos: string[]; opts: Record<string, string> } | null {
  const pos: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (known.includes(a)) {
      const v = args[++i];
      if (v === undefined) return null;
      opts[a] = v;
    } else {
      pos.push(a);
    }
  }
  return { pos, opts };
}

const flowsDir = () => resolve(FLOWS_DIR);

function report(skipped: string[]): void {
  if (skipped.length) console.error(`skipped (no counterpart):\n${skipped.map((s) => `  ${s}`).join("\n")}`);
}

/** `droidreplay export <flow> [--app-id pkg] [--out file]`: a flow as Maestro YAML. */
export async function exportCli(args: string[]): Promise<number> {
  const p = parseArgs(args, ["--app-id", "--out"]);
  if (!p || p.pos.length !== 1) {
    console.error("usage: droidreplay export <flow name or .yaml path> [--app-id package] [--out file]");
    return 2;
  }
  try {
    const { flow } = await loadFlow(flowsDir(), p.pos[0]);
    const { out, skipped } = toMaestro(flow, p.opts["--app-id"]);
    if (p.opts["--out"]) {
      await writeFile(p.opts["--out"], out);
      console.error(`wrote ${p.opts["--out"]}`);
    } else {
      process.stdout.write(out);
    }
    report(skipped);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

/** `droidreplay import <maestro.yaml> [--name n] [--out path]`: saves a Maestro file as a flow. */
export async function importCli(args: string[]): Promise<number> {
  const p = parseArgs(args, ["--name", "--out"]);
  if (!p || p.pos.length !== 1) {
    console.error("usage: droidreplay import <maestro .yaml> [--name flow-name] [--out file.yaml]");
    return 2;
  }
  try {
    const src = p.pos[0];
    const { out: flow, skipped } = fromMaestro(await readFile(src, "utf8"), p.opts["--name"]);
    // A Maestro header rarely has a name; fall back to the output file's, else the source's.
    if (!p.opts["--name"] && flow.name === "maestro") flow.name = basename(p.opts["--out"] ?? src).replace(/\.ya?ml$/, "");
    flow.name = safeFlowName(flow.name);
    const dest = resolve(p.opts["--out"] ?? flowPath(flowsDir(), flow.name));
    if (await access(dest).then(() => true, () => false)) {
      console.error(`${dest} exists; pick another --name or --out`);
      return 1;
    }
    console.log(`saved ${await saveFlow(flowsDir(), flow, dest)} (${flow.steps.length} steps)`);
    report(skipped);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}
