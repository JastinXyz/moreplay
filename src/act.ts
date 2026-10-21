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

export interface ActOptions {
  observeAfter?: boolean;
  evidenceDir: string;
}

/**
 * Runs steps in order. Consecutive agent ops go to the device in one request; host ops run
 * here in between. Stops at the first failure, then appends the screen unless told not to.
 */
export async function runAct(device: ActDevice, steps: Step[], opts: ActOptions): Promise<string> {
  const lines: string[] = [];
  let failed = false;
  let pending: Step[] = [];

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
      lines.push(fmt({ op: step.op, ok: true, ms: 0, out: await hostOp(device, step, opts.evidenceDir) }, Date.now() - t0));
    } catch (e) {
      lines.push(fmt({ op: step.op, ok: false, ms: 0, error: (e as Error).message }, Date.now() - t0));
      failed = true;
    }
  }
  await flush();

  if (opts.observeAfter !== false && steps[steps.length - 1].op !== "observe") {
    const r = await device.run([{ op: "wait_idle", quietMs: 250, timeout: 2000 }, { op: "observe" }]);
    lines.push("--- screen", r.results[1]?.out ?? "");
  }
  return lines.join("\n");
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
