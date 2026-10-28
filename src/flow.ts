import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { executeSteps, NESTED_KEYS, RELATIVE_KEYS, saveScreenshot, screen, type ActDevice, type Step, type Subflows } from "./act.js";
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
  /** For picking flows out of a folder: `droidreplay run dir --include-tags smoke`. */
  tags?: string[];
  steps: Record<string, unknown>[];
}

// The single value a short step stands for, per op.
const SHORT_KEY: Record<string, string> = {
  launch: "package",
  stop_app: "package",
  clear_app: "package",
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
const SELECTOR_KEYS = ["ref", "x", "y", "text", "id", "desc", "field", ...RELATIVE_KEYS, ...NESTED_KEYS];

export const DEFAULT_WAIT_MS = 5000;

// Defaults, relative to where the server or CLI runs; callers can pass their own paths.
export const FLOWS_DIR = ".droidreplay/flows";
export const EVIDENCE_DIR = ".droidreplay/evidence";

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

/**
 * Puts `${name}` back wherever a var's value shows up in a string, so a recorded flow never
 * holds the secret itself, even when the model typed the value instead of the placeholder.
 * Values under 3 characters are left alone; replacing every "1" would wreck the flow.
 */
export function hideVars(step: Step, vars: Record<string, string>): Step {
  const pairs = Object.entries(vars)
    .filter(([, v]) => v.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
  if (!pairs.length) return step;
  const hide = (v: unknown): unknown => {
    if (typeof v === "string") return pairs.reduce((s, [k, val]) => s.split(val).join(`\${${k}}`), v);
    if (Array.isArray(v)) return v.map(hide);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hide(x)]));
    return v;
  };
  return hide(step) as Step;
}

export class Recorder {
  readonly steps: Step[] = [];
  /** `vars` fill `${name}` in act steps while recording and are hidden again in what is saved. */
  constructor(
    readonly name: string,
    readonly vars: Record<string, string> = {},
  ) {}

  add(step: Step, result: StepResult): void {
    const recorded = toRecorded(step, result);
    if (recorded) this.steps.push(hideVars(recorded, this.vars));
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

const isPath = (s: string) => /[/\\]/.test(s) || /\.ya?ml$/.test(s);

/** A name resolves to <dir>/<name>.yaml; anything with a slash or .yaml is taken as a path. */
export function flowPath(dir: string, nameOrPath: string): string {
  if (isPath(nameOrPath)) return nameOrPath;
  return join(dir, `${safeFlowName(nameOrPath)}.yaml`);
}

/** The flow's name for a name or a path (`/x/login.yaml` -> `login`). */
export function flowName(nameOrPath: string): string {
  return safeFlowName(isPath(nameOrPath) ? basename(nameOrPath) : nameOrPath);
}

/** Saves to `target` (a name in `dir`, or a path), the flow's own name by default. */
export async function saveFlow(dir: string, flow: FlowFile, target = flow.name): Promise<string> {
  const path = flowPath(dir, target);
  await mkdir(dirname(path), { recursive: true });
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
  // A run_flow's own steps are filled when it runs, with its vars on top of these.
  const out = steps.map((s) => {
    if (s.op !== "run_flow" || !("steps" in s)) return fill(s) as Step;
    const { steps: inner, ...rest } = s;
    return { ...(fill(rest) as Step), steps: inner };
  });
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
  /** Folder of the flow file; relative run_flow files resolve against it (default: cwd). */
  dir?: string;
  /** Gets each step's result (0-based index) as soon as it finishes; the CLI prints them live. */
  onStep?: (index: number, result: StepResult) => void;
}

export interface FlowRun {
  ok: boolean;
  text: string;
  evidenceDir: string;
  /** Whether any screenshot was saved under evidenceDir. */
  shots: boolean;
  secs: string;
  /** 1-based step number that failed. */
  failedStep?: number;
  /** The app's crash, when a step failed because it died. */
  crash?: string;
  /** The failed step's error. */
  error?: string;
  /** Files saved when a step failed: a screenshot and the screen as text. */
  artifacts?: string[];
}

export async function runFlow(device: ActDevice, flow: FlowFile, opts: RunFlowOptions): Promise<FlowRun> {
  const steps = withDismiss(withWaits(substitute(flow.steps.map(fromCompact), opts.vars ?? {}), opts.waitMs), flow.dismiss);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const evidenceDir = join(opts.evidenceDir, safeFlowName(flow.name), stamp);
  const t0 = Date.now();
  const prepare = (raw: Record<string, unknown>[], vars: Record<string, string>) =>
    withDismiss(withWaits(substitute(raw.map(fromCompact), vars), opts.waitMs), flow.dismiss);
  const subflows: Subflows = { load: loadSubflow, prepare, vars: opts.vars ?? {}, dir: opts.dir ?? process.cwd() };
  const exec = await executeSteps(device, steps, evidenceDir, opts.onStep && ((r, i) => opts.onStep!(i, r)), subflows);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  let shots = exec.outcomes.some((o) => o.step.op === "screenshot" && o.result.ok);
  let artifacts: string[] = [];
  const lines = exec.lines.map((l, i) => `${i + 1}. ${l}`);
  const tail: string[] = [];
  const done = (ok: boolean, failedStep?: number): FlowRun => ({
    ok,
    text: [...lines, ...tail].join("\n"),
    evidenceDir,
    shots,
    secs,
    ...(failedStep ? { failedStep } : {}),
    ...(exec.crash ? { crash: exec.crash } : {}),
    ...(exec.failedAt !== undefined ? { error: exec.outcomes[exec.failedAt].result.error ?? "" } : {}),
    ...(artifacts.length ? { artifacts } : {}),
  });

  if (exec.failedAt === undefined) {
    tail.push(`✓ flow ${flow.name} passed: ${steps.length} steps in ${secs}s${shots ? `, evidence in ${evidenceDir}` : ""}`);
    return done(true);
  }
  const n = exec.failedAt + 1;
  tail.push(
    `✗ flow ${flow.name} failed at step ${n}/${steps.length} after ${secs}s: ${stringify(flow.steps[exec.failedAt], { lineWidth: 0 }).trim()}`,
  );
  // What the screen looked like when it broke, kept next to the run's other evidence.
  let scr = "";
  try {
    scr = await screen(device);
    await mkdir(evidenceDir, { recursive: true });
    const txt = join(evidenceDir, `failed-step-${n}.txt`);
    await writeFile(txt, scr);
    artifacts = [await saveScreenshot(device, evidenceDir, `failed-step-${n}`), txt];
    shots = true;
    tail.push(`failure artifacts: ${artifacts.join(", ")}`);
  } catch {
    // The device may be gone (that can be why the step failed); the failure itself still reports.
  }
  if (opts.screenOnFailure) {
    tail.push("--- screen", scr);
    tail.push(`Fix it with flow {action: "patch", name: "${flow.name}", index: ${n}, steps: [...]}, then run again.`);
  }
  return done(false, n);
}

/**
 * Flow files for `droidreplay run`: a folder stands for the .yaml files directly in it, sorted
 * by name (subfolders hold subflows, so they are not run on their own); anything else is a flow
 * name or path as usual.
 */
export async function collectFlows(targets: string[], flowsDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const t of targets) {
    const isDir = await stat(t).then((s) => s.isDirectory(), () => false);
    if (!isDir) {
      out.push(resolve(flowPath(flowsDir, t)));
      continue;
    }
    const files = (await readdir(t)).filter((f) => /\.ya?ml$/.test(f)).sort();
    out.push(...files.map((f) => resolve(t, f)));
  }
  return out;
}

/** Splits flows by tags: any `include` tag (when given) and no `exclude` tag runs. */
export function pickByTags<T extends { flow: FlowFile }>(flows: T[], include: string[], exclude: string[]): { run: T[]; skipped: T[] } {
  const run: T[] = [];
  const skipped: T[] = [];
  for (const f of flows) {
    const tags = f.flow.tags ?? [];
    const ok = (!include.length || include.some((t) => tags.includes(t))) && !exclude.some((t) => tags.includes(t));
    (ok ? run : skipped).push(f);
  }
  return { run, skipped };
}

/** A run_flow file: a path (`.yaml` optional) relative to the calling flow's folder. */
export async function loadSubflow(file: string, dir: string): Promise<{ steps: Record<string, unknown>[]; dir: string }> {
  const named = /\.ya?ml$/.test(file) ? file : `${file}.yaml`;
  const path = isAbsolute(named) ? named : resolve(dir, named);
  const { flow } = await loadFlow(dir, path);
  return { steps: flow.steps, dir: dirname(path) };
}

/** Replaces step `index` (1-based) with `steps` (zero steps deletes it). */
export function patchSteps(flow: FlowFile, index: number, steps: Record<string, unknown>[]): FlowFile {
  if (!Number.isInteger(index) || index < 1 || index > flow.steps.length) {
    throw new Error(`index must be 1..${flow.steps.length}`);
  }
  const replacement = steps.map((s) => toCompact(fromCompact(s)));
  return { ...flow, steps: [...flow.steps.slice(0, index - 1), ...replacement, ...flow.steps.slice(index)] };
}
