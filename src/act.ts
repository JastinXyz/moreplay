import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunResult, StepResult } from "./device.js";

/** What `act` needs from a device; `Device` implements it, tests pass a fake. */
export interface ActDevice {
  run(steps: object[], stopOnError?: boolean): Promise<RunResult>;
  shell(cmd: string): Promise<string>;
  screenshot(max: number, quality: number): Promise<Buffer>;
}

export type Step = { op: string } & Record<string, unknown>;

// Ops handled on the laptop side; everything else goes to the on-device agent in one request.
export const HOST_OPS = new Set(["launch", "stop_app", "apps", "screenshot"]);

// How long the tree must stay unchanged before a screenshot step captures it.
const SETTLE_MS = 400;

export interface ActOptions {
  observeAfter?: boolean;
  evidenceDir: string;
  /** Gets every step that succeeded, with the agent's result, e.g. to record a flow. */
  onSuccess?: (step: Step, result: StepResult) => void;
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
}

/**
 * Runs steps in order. Consecutive agent ops go to the device in one request; host ops run
 * here in between. Stops at the first failure.
 */
export async function executeSteps(device: ActDevice, steps: Step[], evidenceDir: string): Promise<Execution> {
  const lines: string[] = [];
  const outcomes: Outcome[] = [];
  let failedAt: number | undefined;
  let pending: Step[] = [];

  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const r = await device.run(batch, true);
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
      result = { op: step.op, ok: true, ms: 0, out: await hostOp(device, step, evidenceDir) };
    } catch (e) {
      result = { op: step.op, ok: false, ms: 0, error: (e as Error).message };
    }
    result.ms = Date.now() - t0;
    lines.push(fmt(result));
    outcomes.push({ step, result });
    if (!result.ok) failedAt = outcomes.length - 1;
  }
  await flush();
  return { lines, outcomes, failedAt };
}

/** The `act` tool: executeSteps, then the screen afterwards unless told not to. */
export async function runAct(device: ActDevice, steps: Step[], opts: ActOptions): Promise<string> {
  const { lines, outcomes } = await executeSteps(device, steps, opts.evidenceDir);
  if (opts.onSuccess) for (const o of outcomes) if (o.result.ok) opts.onSuccess(o.step, o.result);
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

async function hostOp(device: ActDevice, step: Step, evidenceDir: string): Promise<string> {
  switch (step.op) {
    case "launch": {
      const pkg = packageOf(step);
      const activity = (await device.shell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg} | tail -1`)).trim();
      if (!/^[\w.$]+\/[\w.$]+$/.test(activity)) throw new Error(`no launchable activity for ${pkg} (installed? see apps)`);
      await device.shell(`am start -n '${activity}'`);
      return `launched ${activity}`;
    }
    case "stop_app": {
      const pkg = packageOf(step);
      await device.shell(`am force-stop ${pkg}`);
      return `stopped ${pkg}`;
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

export async function saveScreenshot(device: ActDevice, evidenceDir: string, name?: string): Promise<string> {
  const img = await device.screenshot(0, 85);
  const safe = (name ?? new Date().toISOString().replace(/[:.]/g, "-")).replace(/[^\w.-]+/g, "_");
  await mkdir(evidenceDir, { recursive: true });
  const path = join(evidenceDir, safe.endsWith(".jpg") ? safe : `${safe}.jpg`);
  await writeFile(path, img);
  return path;
}
