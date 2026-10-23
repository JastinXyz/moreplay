import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse, stringify } from "yaml";
import { executeSteps, screen, type ActDevice, type Step } from "./act.js";
import type { StepResult } from "./device.js";

/**
 * A flow file is YAML, one op per step, with a short form for one-value steps:
 *   - launch: com.app
 *   - tap: Masuk                      # same as {text: Masuk}
 *   - type: {field: Email, value: "${email}"}
 * An optional top-level `dismiss: [Lanjut ke aplikasi, {id: close}]` lists things to tap away
 * whenever they appear while a step waits (ads, prompts that show up only sometimes).
 */
export interface FlowFile {
  name: string;
  /** Tapped whenever they show up while a step waits: interstitial closes, permission prompts. */
  dismiss?: (string | Record<string, unknown>)[];
  steps: Record<string, unknown>[];
}

// The single value a short step stands for, per op.
const SHORT_KEY: Record<string, string> = {
  launch: "package",
  stop_app: "package",
  key: "key",
  screenshot: "name",
  sleep: "ms",
  scroll: "dir",
  apps: "filter",
  tap: "text",
  long_press: "text",
  wait_for: "text",
  wait_gone: "text",
  type: "value",
};

// Never worth replaying: they only look, and replays wait for elements on their own.
const NOT_RECORDED = new Set(["observe", "apps", "wait_idle"]);
const TARGETED = new Set(["tap", "long_press", "type"]);
const SELECTOR_KEYS = ["ref", "x", "y", "text", "id", "desc", "field"];

export const DEFAULT_WAIT_MS = 5000;

export function toCompact(step: Step): Record<string, unknown> {
  const { op, ...params } = step;
  const keys = Object.keys(params);
  const short = SHORT_KEY[op];
  if (short && keys.length === 1 && keys[0] === short && typeof params[short] !== "object") return { [op]: params[short] };
  return { [op]: keys.length ? params : {} };
}

/** Accepts the short YAML form ({tap: Masuk}) or the act form ({op: "tap", text: "Masuk"}). */
export function fromCompact(item: Record<string, unknown>): Step {
  if (typeof item.op === "string") return item as Step;
  const keys = Object.keys(item);
  if (keys.length !== 1) throw new Error(`a step needs exactly one op, got: ${JSON.stringify(item)}`);
  const op = keys[0];
  const value = item[op];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return { op, ...(value as Record<string, unknown>) };
  const short = SHORT_KEY[op];
  if (value === null || value === undefined) return { op };
  if (!short) throw new Error(`${op} needs an object, got: ${JSON.stringify(value)}`);
  return { op, [short]: value };
}

/**
 * Turns a step that just succeeded into the form worth saving: refs become the stable
 * selector the agent reported, so the flow does not depend on this screen's numbering.
 * Returns null for steps that should not be replayed.
 */
export function toRecorded(step: Step, result: StepResult): Step | null {
  if (NOT_RECORDED.has(step.op)) return null;
  const { wait: _wait, ...clean } = step;
  if (!("ref" in clean)) return clean as Step;
  const { ref: _ref, ...rest } = clean;
  if (result.sel) {
    const sel = { ...result.sel };
    // type looks up its field by label under "field"; "text" there would mean the value.
    if (step.op === "type" && sel.text !== undefined) {
      sel.field = sel.text;
      delete sel.text;
    }
    return { ...rest, ...sel } as Step;
  }
  // No id or label: keep the coordinates the agent tapped.
  const m = /tapped (\d+),(\d+)/.exec(result.out ?? "");
  return m ? ({ ...rest, x: Number(m[1]), y: Number(m[2]) } as Step) : (rest as Step);
}

export class Recorder {
  readonly steps: Step[] = [];
  constructor(readonly name: string) {}

  add(step: Step, result: StepResult): void {
    const recorded = toRecorded(step, result);
    if (recorded) this.steps.push(recorded);
  }

  toFile(): FlowFile {
    return { name: this.name, steps: this.steps.map(toCompact) };
  }
}

export function safeFlowName(name: string): string {
  const safe = name.trim().replace(/\.ya?ml$/, "").replace(/[^\w-]+/g, "-");
  if (!safe) throw new Error("flow name is empty");
  return safe;
}

/** A name resolves to <dir>/<name>.yaml; anything with a slash or .yaml is taken as a path. */
export function flowPath(dir: string, nameOrPath: string): string {
  if (nameOrPath.includes("/") || /\.ya?ml$/.test(nameOrPath)) return nameOrPath;
  return join(dir, `${safeFlowName(nameOrPath)}.yaml`);
}

export async function saveFlow(dir: string, flow: FlowFile): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = flowPath(dir, flow.name);
  await writeFile(path, stringify(flow, { lineWidth: 0 }));
  return path;
}

export async function loadFlow(dir: string, nameOrPath: string): Promise<{ path: string; flow: FlowFile }> {
  const path = flowPath(dir, nameOrPath);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`flow not found: ${path}`);
  }
  const flow = parse(raw) as FlowFile;
  if (!flow || !Array.isArray(flow.steps)) throw new Error(`${path} has no steps list`);
  flow.name ??= basename(path).replace(/\.ya?ml$/, "");
  return { path, flow };
}

export async function listFlows(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).map((f) => f.replace(/\.ya?ml$/, "")).sort();
  } catch {
    return [];
  }
}

/** Replaces ${name} in every string value. Throws listing every variable that has no value. */
export function substitute(steps: Step[], vars: Record<string, string>): Step[] {
  const missing = new Set<string>();
  const fill = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.replace(/\$\{(\w+)\}/g, (_, k: string) => {
        if (k in vars) return vars[k];
        missing.add(k);
        return "";
      });
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  const out = steps.map((s) => fill(s) as Step);
  if (missing.size) throw new Error(`missing variable(s): ${[...missing].join(", ")} (pass them in vars / --var)`);
  return out;
}

/** Replays wait for each element instead of relying on fixed sleeps. */
export function withWaits(steps: Step[], waitMs = DEFAULT_WAIT_MS): Step[] {
  return steps.map((s) => {
    if (TARGETED.has(s.op) && SELECTOR_KEYS.some((k) => k in s && k !== "x" && k !== "y") && !("wait" in s)) return { ...s, wait: waitMs };
    if ((s.op === "wait_for" || s.op === "wait_gone") && !("timeout" in s)) return { ...s, timeout: waitMs };
    return s;
  });
}

/** Hands the flow's dismiss list to every step that waits for an element. */
export function withDismiss(steps: Step[], dismiss: FlowFile["dismiss"]): Step[] {
  if (!dismiss?.length) return steps;
  const list = dismiss.map((d) => (typeof d === "string" ? { text: d } : d));
  return steps.map((s) => (TARGETED.has(s.op) || s.op === "wait_for" ? { ...s, dismiss: list } : s));
}

export interface RunFlowOptions {
  vars?: Record<string, string>;
  evidenceDir: string;
  waitMs?: number;
  /** Append the screen at the failing step (for a model to patch the flow). */
  screenOnFailure?: boolean;
}

export interface FlowRun {
  ok: boolean;
  text: string;
  evidenceDir: string;
  /** 1-based step number that failed. */
  failedStep?: number;
}

export async function runFlow(device: ActDevice, flow: FlowFile, opts: RunFlowOptions): Promise<FlowRun> {
  const steps = withDismiss(withWaits(substitute(flow.steps.map(fromCompact), opts.vars ?? {}), opts.waitMs), flow.dismiss);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const evidenceDir = join(opts.evidenceDir, safeFlowName(flow.name), stamp);
  const t0 = Date.now();
  const exec = await executeSteps(device, steps, evidenceDir);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const shots = exec.outcomes.some((o) => o.step.op === "screenshot" && o.result.ok);
  const lines = exec.lines.map((l, i) => `${i + 1}. ${l}`);

  if (exec.failedAt === undefined) {
    lines.push(`✓ flow ${flow.name} passed: ${steps.length} steps in ${secs}s${shots ? `, evidence in ${evidenceDir}` : ""}`);
    return { ok: true, text: lines.join("\n"), evidenceDir };
  }
  const n = exec.failedAt + 1;
  lines.push(
    `✗ flow ${flow.name} failed at step ${n}/${steps.length} after ${secs}s: ${stringify(flow.steps[exec.failedAt], { lineWidth: 0 }).trim()}`,
  );
  if (opts.screenOnFailure) {
    lines.push("--- screen", await screen(device));
    lines.push(`Fix it with flow {action: "patch", name: "${flow.name}", index: ${n}, steps: [...]}, then run again.`);
  }
  return { ok: false, text: lines.join("\n"), evidenceDir, failedStep: n };
}

/** Replaces step `index` (1-based) with `steps` (zero steps deletes it). */
export function patchSteps(flow: FlowFile, index: number, steps: Record<string, unknown>[]): FlowFile {
  if (!Number.isInteger(index) || index < 1 || index > flow.steps.length) {
    throw new Error(`index must be 1..${flow.steps.length}`);
  }
  const replacement = steps.map((s) => toCompact(fromCompact(s)));
  return { ...flow, steps: [...flow.steps.slice(0, index - 1), ...replacement, ...flow.steps.slice(index)] };
}
