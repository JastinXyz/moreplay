import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { RunResult, StepResult } from "./device.js";

/** What `act` needs from a device; `Device` implements it, tests pass a fake. */
export interface ActDevice {
  run(steps: object[], stopOnError?: boolean, onResult?: (r: StepResult) => void): Promise<RunResult>;
  shell(cmd: string): Promise<string>;
  screenshot(max: number, quality: number): Promise<Buffer>;
  /** `adb install -r` (with `-g` to grant every runtime permission); returns adb's answer. */
  install(apk: string, grantAll: boolean): Promise<string>;
}

export type Step = { op: string } & Record<string, unknown>;

// Ops handled on the laptop side; everything else goes to the on-device agent in one request.
export const HOST_OPS = new Set([
  "launch", "stop_app", "clear_app", "install_app", "uninstall_app", "open_link", "permissions", "logs", "apps", "screenshot", "run_flow", "repeat",
]);

// How long the tree must stay unchanged before a screenshot step captures it.
const SETTLE_MS = 400;

const TARGETED = new Set(["tap", "long_press", "type"]);
/** Position keys of a target (the agent's `Device.RELATIVE`): below/above/leftOf/rightOf another target. */
export const RELATIVE_KEYS = ["below", "above", "leftOf", "rightOf"];
/** Target keys that name another target: the element sits inside it / holds it. */
export const NESTED_KEYS = ["childOf", "containsChild"];
/** On/off filters on a target. */
export const STATE_KEYS = ["enabled", "checked", "selected", "focused"];
// A step that opens a sheet or a screen returns before its content is in the tree, so the
// next tap in the same batch would miss it.
const ACT_WAIT_MS = 3000;

/** Lets every selector-targeted step after the first wait briefly for its element. */
export function withActWaits(steps: Step[]): Step[] {
  return steps.map((s, i) =>
    i > 0 && TARGETED.has(s.op) && !("wait" in s) && ["text", "id", "desc", "field", ...RELATIVE_KEYS, ...NESTED_KEYS].some((k) => k in s) ? { ...s, wait: ACT_WAIT_MS } : s,
  );
}

/**
 * What `run_flow` needs to expand a subflow. flow.ts supplies it (loading files, vars, waits),
 * so this file does not depend on it.
 */
export interface Subflows {
  /** Reads a subflow file given relative to `dir`: its raw steps and the folder it lives in. */
  load(file: string, dir: string): Promise<{ steps: Record<string, unknown>[]; dir: string }>;
  /** Raw (short or act form) steps -> runnable steps with these vars filled in. */
  prepare(steps: Record<string, unknown>[], vars: Record<string, string>): Step[];
  vars: Record<string, string>;
  /** Folder that relative subflow files resolve against. */
  dir: string;
  depth?: number;
}

// A flow that runs itself would never end.
const MAX_DEPTH = 8;

/** `when: {visible: target}` or `{notVisible: target}`, checked once on the current screen. */
async function conditionMet(device: ActDevice, when: unknown): Promise<boolean> {
  const w = (when ?? {}) as Record<string, unknown>;
  // {true: "${!!CARD}"}: decided by the vars alone, after substitution.
  if ("true" in w) return String(w.true).trim() === "true";
  const gone = "notVisible" in w;
  const t = gone ? w.notVisible : w.visible;
  if (t === undefined) throw new Error("when needs visible, notVisible or true");
  const sel = t && typeof t === "object" ? t : { text: String(t) };
  const r = (await device.run([{ op: gone ? "wait_gone" : "wait_for", ...sel, timeout: 0 }])).results[0];
  // Not met is a timeout; anything else (a bad regex, a bad anchor) is a real error.
  if (r && !r.ok && !/^timeout waiting/.test(r.error ?? "")) throw new Error(r.error);
  return !!r?.ok;
}

/** Runs a run_flow step; returns its output line or throws with the inner step that failed. */
async function runSubflow(device: ActDevice, step: Step, evidenceDir: string, sub?: Subflows): Promise<string> {
  if (!sub) throw new Error("run_flow is not available here");
  const depth = sub.depth ?? 0;
  if (depth >= MAX_DEPTH) throw new Error(`run_flow nested more than ${MAX_DEPTH} deep (does a flow run itself?)`);
  if (step.when !== undefined && !(await conditionMet(device, step.when))) return "skipped (when not met)";
  let raw: Record<string, unknown>[];
  let dir = sub.dir;
  if (typeof step.file === "string") ({ steps: raw, dir } = await sub.load(step.file, sub.dir));
  else if (Array.isArray(step.steps)) raw = step.steps as Record<string, unknown>[];
  else throw new Error("run_flow needs file or steps");
  const vars = { ...sub.vars, ...((step.vars as Record<string, string> | undefined) ?? {}) };
  const steps = sub.prepare(raw, vars);
  const exec = await executeSteps(device, steps, evidenceDir, undefined, { ...sub, vars, dir, depth: depth + 1 });
  if (exec.failedAt !== undefined) {
    const o = exec.outcomes[exec.failedAt];
    throw new Error(`step ${exec.failedAt + 1} (${o.step.op}) failed: ${o.result.error ?? ""}`);
  }
  return `ran ${steps.length} steps`;
}

// `repeat` with only `while` stops here instead of looping forever.
const MAX_REPEAT = 100;

/** Runs a repeat step: `steps` up to `times`, while `while` holds (checked before each round). */
async function runRepeat(device: ActDevice, step: Step, evidenceDir: string, sub?: Subflows): Promise<string> {
  if (!sub) throw new Error("repeat is not available here");
  if (!Array.isArray(step.steps)) throw new Error("repeat needs steps");
  const times = step.times === undefined ? undefined : Number(step.times);
  if (times === undefined && step.while === undefined) throw new Error("repeat needs times or while");
  const limit = times ?? MAX_REPEAT;
  let n = 0;
  for (; n < limit; n++) {
    if (step.while !== undefined && !(await conditionMet(device, step.while))) break;
    const steps = sub.prepare(step.steps as Record<string, unknown>[], sub.vars);
    const exec = await executeSteps(device, steps, evidenceDir, undefined, { ...sub, depth: (sub.depth ?? 0) + 1 });
    if (exec.failedAt !== undefined) {
      const o = exec.outcomes[exec.failedAt];
      throw new Error(`round ${n + 1}, step ${exec.failedAt + 1} (${o.step.op}) failed: ${o.result.error ?? ""}`);
    }
  }
  if (times === undefined && n === limit) throw new Error(`while still true after ${MAX_REPEAT} rounds`);
  return `ran ${n} time${n === 1 ? "" : "s"}`;
}

export interface ActOptions {
  observeAfter?: boolean;
  evidenceDir: string;
  /** Gets every step that succeeded, with the agent's result, e.g. to record a flow. */
  onSuccess?: (step: Step, result: StepResult) => void;
  /** Lets steps use run_flow. */
  subflows?: Subflows;
}

export interface Outcome {
  step: Step;
  result: StepResult;
}

export interface Execution {
  lines: string[];
  outcomes: Outcome[];
  /** Index into the input steps of the step that failed, if any. */
  failedAt?: number;
  /** When a step failed because the app crashed: the exception and its top frames. */
  crash?: string;
}

/**
 * Runs steps in order. Consecutive agent ops go to the device in one request; host ops run
 * here in between. Stops at the first failure. `onStep` gets each step's result (and its
 * 0-based index) as soon as the step finishes.
 */
export async function executeSteps(
  device: ActDevice,
  steps: Step[],
  evidenceDir: string,
  onStep?: (result: StepResult, index: number) => void,
  subflows?: Subflows,
): Promise<Execution> {
  const lines: string[] = [];
  const t0 = Date.now();
  let emitted = 0;
  const emit = onStep && ((r: StepResult) => onStep(r, emitted++));
  const outcomes: Outcome[] = [];
  let failedAt: number | undefined;
  let pending: Step[] = [];

  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const r = await device.run(batch, true, emit);
    r.results.forEach((res, i) => {
      lines.push(fmt(res));
      outcomes.push({ step: batch[i], result: res });
      if (!res.ok && failedAt === undefined) failedAt = outcomes.length - 1;
    });
  };

  for (const step of steps) {
    if (failedAt !== undefined) break;
    if (!HOST_OPS.has(step.op)) {
      pending.push(step);
      continue;
    }
    await flush();
    if (failedAt !== undefined) break;
    const t0 = Date.now();
    let result: StepResult;
    try {
      // Evidence must show the screen a tap led to, not the transition. Replays tap and shoot
      // back to back, so let the screen settle first.
      if (step.op === "screenshot") await device.run([{ op: "wait_idle", quietMs: SETTLE_MS, timeout: 3000 }]);
      const out =
        step.op === "run_flow" ? await runSubflow(device, step, evidenceDir, subflows)
        : step.op === "repeat" ? await runRepeat(device, step, evidenceDir, subflows)
        : await hostOp(device, step, evidenceDir);
      result = { op: step.op, ok: true, ms: 0, out };
    } catch (e) {
      result = { op: step.op, ok: false, ms: 0, error: (e as Error).message };
    }
    result.ms = Date.now() - t0;
    emit?.(result);
    lines.push(fmt(result));
    outcomes.push({ step, result });
    if (!result.ok) failedAt = outcomes.length - 1;
  }
  await flush();
  // A step that fails because the app died says so; checked only on failure, at the top level.
  let crash: string | undefined;
  if (failedAt !== undefined && !(subflows?.depth ?? 0)) {
    crash = await recentCrash(device, Math.ceil((Date.now() - t0) / 1000) + 2);
    if (crash) {
      outcomes[failedAt].result.error = `${outcomes[failedAt].result.error ?? ""}\n${crash}`;
      lines[failedAt] = fmt(outcomes[failedAt].result);
    }
  }
  return { lines, outcomes, failedAt, crash };
}

/** The `act` tool: executeSteps, then the screen afterwards unless told not to. */
export async function runAct(device: ActDevice, steps: Step[], opts: ActOptions): Promise<string> {
  const { lines, outcomes } = await executeSteps(device, withActWaits(steps), opts.evidenceDir, undefined, opts.subflows);
  // Record the steps as given: the implicit wait is not part of the flow.
  if (opts.onSuccess) outcomes.forEach((o, i) => o.result.ok && opts.onSuccess!(steps[i], o.result));
  if (opts.observeAfter !== false && steps[steps.length - 1].op !== "observe") {
    lines.push("--- screen", await screen(device));
  }
  return lines.join("\n");
}

export async function screen(device: ActDevice): Promise<string> {
  const r = await device.run([{ op: "wait_idle", quietMs: 250, timeout: 2000 }, { op: "observe" }]);
  return r.results[1]?.out ?? r.results[0]?.error ?? "";
}

export function fmt(s: StepResult, ms = s.ms): string {
  const body = (s.ok ? s.out : s.error) ?? "";
  // Multi-line output (observe) goes below the status line.
  return body.includes("\n") ? `${s.ok ? "✓" : "✗"} ${s.op} ${ms}ms\n${body.trimEnd()}` : `${s.ok ? "✓" : "✗"} ${s.op} ${ms}ms ${body}`;
}

// Package names go into adb shell commands, so only accept real package names.
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

function packageOf(step: Step): string {
  const pkg = String(step.package ?? "");
  if (!pkg) throw new Error(`${step.op} needs package`);
  if (!PACKAGE_RE.test(pkg)) throw new Error(`invalid package name: ${pkg}`);
  return pkg;
}

// Log lines are long and repetitive; these keep a `logs` answer to a few hundred tokens.
const LOG_LINE_MAX = 240;
const LOG_LINES_MAX = 500;

/** "90", "30s", "2m", "1h" -> seconds. */
function seconds(v: unknown): number {
  const m = /^(\d+)\s*([smh]?)$/.exec(String(v).trim());
  if (!m) throw new Error(`since must look like 30s, 2m or 1h, got: ${v}`);
  return Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1);
}

/** Trims long lines and folds repeats into one line with a count. */
function squeeze(raw: string, max: number): string[] {
  const out: string[] = [];
  let last = "";
  let count = 0;
  const flush = () => {
    if (count) out.push(count > 1 ? `${last} (x${count})` : last);
  };
  for (const line of raw.split("\n")) {
    const l = line.trimEnd();
    if (!l || l.startsWith("--------- beginning of")) continue;
    const cut = l.length > LOG_LINE_MAX ? `${l.slice(0, LOG_LINE_MAX)}…` : l;
    if (cut === last) count++;
    else {
      flush();
      last = cut;
      count = 1;
    }
  }
  flush();
  return out.slice(-max);
}

/** logs{package?, level?=W, since?=60s, lines?=50}: recent logcat, one app's when it runs. */
async function logs(device: ActDevice, step: Step): Promise<string> {
  const level = String(step.level ?? "W").toUpperCase().slice(0, 1);
  if (!"VDIWEF".includes(level) || !level) throw new Error(`level must be one of V D I W E F, got: ${step.level}`);
  const since = seconds(step.since ?? "60s");
  const max = Math.min(Math.max(Number(step.lines ?? 50) || 50, 1), LOG_LINES_MAX);
  const from = `-T "$(($(date +%s)-${since})).000"`;
  let what = "all apps";
  let cmd = `logcat -d -v brief ${from} '*:${level}'`;
  if (step.package !== undefined) {
    const pkg = packageOf(step);
    const pid = (await device.shell(`pidof ${pkg}; true`)).trim().split(/\s+/)[0];
    if (/^\d+$/.test(pid)) {
      what = pkg;
      cmd = `logcat -d -v brief ${from} --pid=${pid} '*:${level}'`;
    } else {
      // Not running: what usually matters then is how it died.
      what = `${pkg} (not running; crash buffer)`;
      cmd = `logcat -d -b crash -v brief ${from}`;
    }
  }
  const lines = squeeze(await device.shell(`${cmd} 2>&1 | tail -n ${max * 4}`), max);
  return `${what}, level ${level}+, last ${since}s: ${lines.length ? `${lines.length} line(s)\n${lines.join("\n")}` : "nothing"}`;
}

/** The newest crash in the last `secs` seconds: process, exception and top frames, or undefined. */
async function recentCrash(device: ActDevice, secs: number): Promise<string | undefined> {
  try {
    const raw = await device.shell(`logcat -d -b crash -v brief -T "$(($(date +%s)-${secs})).000" 2>/dev/null | tail -n 60`);
    const lines = raw.split("\n").map((l) => l.replace(/^[EF]\/AndroidRuntime\(\s*\d+\):\s?/, "").trimEnd()).filter(Boolean);
    const start = lines.map((l) => /FATAL EXCEPTION/.test(l)).lastIndexOf(true);
    if (start < 0) return undefined;
    const block = lines.slice(start);
    const head = block.filter((l) => !/^\s*at /.test(l)).slice(0, 3);
    const frames = block.filter((l) => /^\s*at /.test(l)).slice(0, 4).map((l) => `  ${l.trim()}`);
    return `app crashed: ${[...head, ...frames].join("\n")}`;
  } catch {
    return undefined; // never hide the step's own error behind a failed crash lookup
  }
}

// clear_app waits at least this long after pm clear (Android revoked a grant ~1 s later on
// Android 14), then up to CLEAR_SETTLE_MS more for the runtime grants to drop.
const CLEAR_MIN_SETTLE_MS = 1500;
const CLEAR_SETTLE_MS = 3000;

/** Runtime permissions still granted for the first user listed in `dumpsys package <pkg>`. */
export function runtimeGranted(dump: string): number {
  const block = /runtime permissions:\n((?:[ \t]+[\w.]+: granted=.*\n?)+)/.exec(dump)?.[1] ?? "";
  return (block.match(/granted=true/g) ?? []).length;
}

/** Single-quotes a value for `adb shell`. */
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** `args: {name: value}` as intent extras: booleans --ez, integers --ei, other numbers --ef, the rest --es. */
function extras(args: unknown): string {
  if (args === undefined) return "";
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("launch args must be {name: value}");
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => {
      if (!/^[\w.-]+$/.test(k)) throw new Error(`launch arg name not allowed: ${k}`);
      if (typeof v === "boolean") return ` --ez ${k} ${v}`;
      if (typeof v === "number") return Number.isInteger(v) ? ` --ei ${k} ${v}` : ` --ef ${k} ${v}`;
      return ` --es ${k} ${quote(String(v))}`;
    })
    .join("");
}

const PERMISSION_RE = /^[A-Za-z][\w.]*$/;
const fullPermission = (p: string) => (p.includes(".") ? p : `android.permission.${p}`);

/** permissions{package, grant?: [names] | "all", revoke?: [names]}; short names get android.permission. */
async function permissions(device: ActDevice, step: Step): Promise<string> {
  const pkg = packageOf(step);
  const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
  let grant = list(step.grant);
  const revoke = list(step.revoke);
  if (!grant.length && !revoke.length) throw new Error("permissions needs grant or revoke");
  let all = false;
  if (grant.length === 1 && grant[0] === "all") {
    // Every permission the app asks for; pm refuses the ones that are not runtime, which is fine.
    all = true;
    const dump = await device.shell(`dumpsys package ${pkg}`);
    const requested = /requested permissions:\n((?:[ \t]+[\w.]+(?:: [^\n]*)?\n)+)/.exec(dump)?.[1] ?? "";
    grant = [...new Set(requested.split("\n").map((l) => l.trim().split(":")[0]).filter(Boolean))];
  }
  const done: string[] = [];
  for (const [verb, names] of [["grant", grant], ["revoke", revoke]] as const) {
    for (const name of names) {
      if (!PERMISSION_RE.test(name)) throw new Error(`permission name not allowed: ${name}`);
      const perm = fullPermission(name);
      const out = await device.shell(`pm ${verb} ${pkg} ${perm} 2>&1; true`);
      if (/Exception|Error|not a changeable|Unknown permission/i.test(out)) {
        if (all) continue;
        // pm prints a header line, then the exception that says why.
        const lines = out.trim().split("\n");
        throw new Error(`pm ${verb} ${perm}: ${(lines.find((l) => /Exception: /.test(l)) ?? lines[0]).trim()}`);
      }
      done.push(`${verb === "grant" ? "+" : "-"}${perm.replace(/^android\.permission\./, "")}`);
    }
  }
  return `${pkg} ${done.join(" ") || "(nothing changed)"}`;
}

async function hostOp(device: ActDevice, step: Step, evidenceDir: string): Promise<string> {
  switch (step.op) {
    case "launch": {
      const pkg = packageOf(step);
      const activity = (await device.shell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg} | tail -1`)).trim();
      if (!/^[\w.$]+\/[\w.$]+$/.test(activity)) throw new Error(`no launchable activity for ${pkg} (installed? see apps)`);
      await device.shell(`am start -n '${activity}'${extras(step.args)}`);
      return `launched ${activity}`;
    }
    case "install_app": {
      const path = resolve(String(step.path ?? ""));
      if (!step.path || !existsSync(path)) throw new Error(`install_app: no file at ${path}`);
      const out = await device.install(path, step.grant === true);
      if (!/Success/.test(out)) throw new Error(`install failed: ${out.trim().split("\n").pop()}`);
      return `installed ${basename(path)}`;
    }
    case "uninstall_app": {
      const pkg = packageOf(step);
      const out = await device.shell(`pm uninstall ${pkg}`).then(
        (o) => o.trim(),
        (e: Error) => e.message.trim().split("\n").pop() ?? "",
      );
      if (out !== "Success") throw new Error(`pm uninstall ${pkg}: ${out || "no answer"}`);
      return `uninstalled ${pkg}`;
    }
    case "open_link": {
      const url = String(step.url ?? "");
      if (!url || /[\r\n]/.test(url)) throw new Error("open_link needs a one-line url");
      const pkg = step.package === undefined ? "" : ` -p ${packageOf(step)}`;
      const out = await device.shell(`am start -W -a android.intent.action.VIEW -d ${quote(url)}${pkg}`);
      const err = /^Error.*$/m.exec(out);
      if (err) throw new Error(`open_link ${url}: ${err[0]}`);
      return `opened ${url}`;
    }
    case "permissions":
      return permissions(device, step);
    case "logs":
      return logs(device, step);
    case "stop_app": {
      const pkg = packageOf(step);
      await device.shell(`am force-stop ${pkg}`);
      return `stopped ${pkg}`;
    }
    case "clear_app": {
      // Like a fresh install: data, cache and runtime permissions go, the app is stopped.
      const pkg = packageOf(step);
      // pm exits non-zero on failure; keep its answer ("Failed"), not adb's command line.
      const out = await device.shell(`pm clear ${pkg}`).then(
        (o) => o.trim(),
        (e: Error) => e.message.trim().split("\n").pop() ?? "",
      );
      if (out !== "Success") throw new Error(`pm clear ${pkg}: ${out || "no answer"}`);
      // pm answers before its permission reset is done: a grant made right after (e.g. a flow's
      // permissions step) is revoked again under a second later, even when nothing was granted
      // before. Wait a fixed moment, then until no runtime permission is still granted.
      await new Promise((r) => setTimeout(r, CLEAR_MIN_SETTLE_MS));
      const deadline = Date.now() + CLEAR_SETTLE_MS;
      while (Date.now() < deadline && runtimeGranted(await device.shell(`dumpsys package ${pkg}`)) > 0) {
        await new Promise((r) => setTimeout(r, 250));
      }
      return `cleared ${pkg}`;
    }
    case "apps": {
      const filter = String(step.filter ?? "").toLowerCase();
      const out = await device.shell("pm list packages -3");
      const pkgs = out.split("\n").map((l) => l.replace("package:", "").trim()).filter((p) => p && p.includes(filter));
      return pkgs.sort().join(" ");
    }
    case "screenshot":
      return `saved ${await saveScreenshot(device, evidenceDir, step.name as string | undefined)}`;
  }
  throw new Error(`unknown op ${step.op}`);
}

/** `name` is a file name in evidenceDir, or a path (absolute, or with a slash) chosen by the caller. */
export function screenshotPath(evidenceDir: string, name?: string): string {
  if (name && (isAbsolute(name) || /[/\\]/.test(name))) return /\.jpe?g$/i.test(name) ? resolve(name) : resolve(`${name}.jpg`);
  const safe = (name ?? new Date().toISOString().replace(/[:.]/g, "-")).replace(/[^\w.-]+/g, "_");
  return join(evidenceDir, safe.endsWith(".jpg") ? safe : `${safe}.jpg`);
}

export async function saveScreenshot(device: ActDevice, evidenceDir: string, name?: string): Promise<string> {
  const img = await device.screenshot(0, 85);
  const path = screenshotPath(evidenceDir, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, img);
  return path;
}
