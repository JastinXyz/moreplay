import type { Step } from "./act.js";
import type { StepResult } from "./device.js";

/**
 * Test-runner style output for `droidreplay run`: one aligned line per step as it finishes,
 * then a PASS/FAIL badge. Colors only on a TTY, and never with NO_COLOR set.
 */
export function useColor(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR) return false;
  // FORCE_COLOR=0 / false turns colors off, as in Node and chalk; any other value turns them on.
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "") return force !== "0" && force !== "false";
  return !!stream.isTTY;
}

const CODES = { green: 32, red: 31, yellow: 33, dim: 2, bold: 1, badgeOk: "30;42", badgeFail: "97;41", badgeRun: "30;46" } as const;
type Style = keyof typeof CODES;

const quote = (v: unknown) => JSON.stringify(String(v));

/** Target of a step as written in the flow: "Sign in", #id, desc="..", 120,340, @4. */
function target(s: Record<string, unknown>): string {
  if (s.ref !== undefined) return `@${s.ref}`;
  if (s.x !== undefined && s.y !== undefined) return `${s.x},${s.y}`;
  const parts: string[] = [];
  if (s.text !== undefined) parts.push(quote(s.text));
  if (s.id !== undefined) parts.push(`#${s.id}`);
  if (s.desc !== undefined) parts.push(`desc=${quote(s.desc)}`);
  if (s.index !== undefined) parts.push(`[${s.index}]`);
  for (const k of ["enabled", "checked", "selected", "focused"]) if (s[k] !== undefined) parts.push(`${s[k] ? "" : "!"}${k}`);
  for (const k of ["childOf", "containsChild"]) {
    const a = s[k];
    if (a !== undefined) parts.push(`${k} ${a && typeof a === "object" ? target(a as Record<string, unknown>) : quote(a)}`);
  }
  for (const k of ["below", "above", "leftOf", "rightOf"]) {
    const a = s[k];
    if (a !== undefined) parts.push(`${k} ${a && typeof a === "object" ? target(a as Record<string, unknown>) : quote(a)}`);
  }
  return parts.join(" ");
}

/** One-line label for a step, from the flow (so `${secret}` stays unexpanded). */
export function describeStep(s: Step): string {
  const t = target(s);
  switch (s.op) {
    case "logs":
      return `logs ${s.package ?? "all"}${s.level ? ` ${String(s.level).toUpperCase()}+` : ""}`;
    case "install_app":
      return `install_app ${s.path}`;
    case "open_link":
      return `open_link ${s.url}`;
    case "permissions":
      return `permissions ${s.package}${s.grant !== undefined ? ` +${[s.grant].flat().join(",")}` : ""}${s.revoke !== undefined ? ` -${[s.revoke].flat().join(",")}` : ""}`;
    case "launch":
    case "stop_app":
    case "clear_app":
    case "uninstall_app":
      return `${s.op} ${s.package}`;
    case "type": {
      const into = s.field !== undefined ? ` into ${quote(s.field)}` : t ? ` into ${t}` : "";
      return `type ${quote(s.value ?? "")}${into}${s.submit ? " + enter" : ""}`;
    }
    case "scroll": {
      const until = s.until === undefined ? "" : ` until ${typeof s.until === "object" ? target(s.until as Record<string, unknown>) : quote(s.until)}`;
      return `scroll ${s.dir ?? "down"}${until}`;
    }
    case "key":
      return `key ${s.key}`;
    case "sleep":
      return `sleep ${s.ms} ms`;
    case "screenshot":
      return s.name ? `screenshot ${s.name}` : "screenshot";
    case "repeat": {
      const n = Array.isArray(s.steps) ? s.steps.length : 0;
      const w = (s.while ?? null) as Record<string, unknown> | null;
      const k = w && ("notVisible" in w ? "notVisible" : "visible");
      const cond = w && k ? ` while ${k} ${w[k] && typeof w[k] === "object" ? target(w[k] as Record<string, unknown>) : quote(w[k])}` : "";
      return `repeat ${n} steps${s.times !== undefined ? ` ${s.times}x` : ""}${cond}`;
    }
    case "run_flow": {
      const what = typeof s.file === "string" ? s.file : `${Array.isArray(s.steps) ? s.steps.length : 0} steps`;
      const w = (s.when ?? null) as Record<string, unknown> | null;
      const k = w && ("true" in w ? "true" : "notVisible" in w ? "notVisible" : "visible");
      const cond = !w || !k ? "" : k === "true" ? ` when ${w.true}` : ` when ${k} ${w[k] && typeof w[k] === "object" ? target(w[k] as Record<string, unknown>) : quote(w[k])}`;
      return `run_flow ${what}${cond}`;
    }
    case "swipe":
      return `swipe ${s.x1},${s.y1} -> ${s.x2},${s.y2}`;
  }
  return t ? `${s.op} ${t}` : s.op;
}

const MAX_LABEL = 48;
const clip = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);

/** Last lines of a run over several flows: totals and the flows that failed. */
export function suiteSummary(
  results: { name: string; ok: boolean; failedStep?: number }[],
  skipped: number,
  secs: string,
  color: boolean,
): string {
  const paint = (code: string, t: string) => (color ? `\x1b[${code}m${t}\x1b[0m` : t);
  const failed = results.filter((r) => !r.ok);
  const parts = [`${results.length - failed.length} passed`];
  if (failed.length) parts.push(`${failed.length} failed`);
  if (skipped) parts.push(`${skipped} skipped by tags`);
  const badge = failed.length ? (color ? paint("97;41", " FAIL ") : "FAIL") : color ? paint("30;42", " PASS ") : "PASS";
  const lines = ["", `${badge}  ${results.length + skipped} flows: ${parts.join(", ")} in ${secs} s`];
  for (const f of failed) lines.push(`  ${paint("31", "✗")} ${f.name}${f.failedStep ? ` (step ${f.failedStep})` : ""}`);
  return lines.join("\n");
}

export class Reporter {
  private readonly labels: string[];
  private readonly width: number;

  constructor(
    private readonly steps: Step[],
    private readonly color: boolean,
  ) {
    this.labels = steps.map((s) => clip(describeStep(s)) + (s.optional ? " (optional)" : ""));
    this.width = Math.max(...this.labels.map((l) => l.length), 10);
  }

  private paint(style: Style, text: string): string {
    return this.color ? `\x1b[${CODES[style]}m${text}\x1b[0m` : text;
  }

  private badge(style: Style, text: string): string {
    return this.color ? this.paint(style, ` ${text} `) : text;
  }

  header(file: string): string {
    return `\n${this.badge("badgeRun", "RUN")}  ${file}  ${this.paint("dim", `${this.steps.length} steps`)}\n`;
  }

  /** The line for step `i` (0-based); a failed step gets its error indented below it. */
  step(i: number, r: StepResult): string {
    const label = this.labels[i].padEnd(this.width);
    const skipped = r.ok && /^skipped/.test(r.out ?? "");
    const ms = `${r.ms} ms`.padStart(8);
    if (!r.ok) {
      return `  ${this.paint("red", "✗")} ${label} ${this.paint("dim", ms)}\n      ${this.paint("red", r.error ?? "failed")}`;
    }
    if (skipped) return `  ${this.paint("yellow", "–")} ${label} ${this.paint("yellow", "skipped".padStart(8))}`;
    const dismissed = /\(dismissed ([^)]*)\)/.exec(r.out ?? "");
    const note = dismissed ? this.paint("dim", `  dismissed ${dismissed[1]}`) : "";
    return `  ${this.paint("green", "✓")} ${label} ${this.paint(r.ms >= 1000 ? "yellow" : "dim", ms)}${note}`;
  }

  /** Steps after a failure that never ran. */
  notRun(from: number): string[] {
    return this.labels.slice(from).map((l) => `  ${this.paint("dim", `○ ${l.padEnd(this.width)}  not run`)}`);
  }

  footer(ok: boolean, secs: string, opts: { failedStep?: number; evidence?: string } = {}): string {
    const n = this.steps.length;
    const lines = [""];
    if (ok) lines.push(`${this.badge("badgeOk", "PASS")}  ${n} steps in ${secs} s`);
    else lines.push(`${this.badge("badgeFail", "FAIL")}  step ${opts.failedStep} of ${n} failed after ${secs} s`);
    if (opts.evidence) lines.push(`${this.paint("dim", "Evidence")}  ${opts.evidence}`);
    return lines.join("\n");
  }
}

export interface FlowReport {
  /** Flow file as shown to the user (relative path). */
  file: string;
  name: string;
  ok: boolean;
  secs: number;
  failedStep?: number;
  error?: string;
  crash?: string;
  artifacts?: string[];
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

/**
 * JUnit XML for CI (GitHub Actions, GitLab, Jenkins read it): one testcase per flow, a
 * `<failure>` with the step, its error, the crash and the failure artifacts, `<skipped>` for
 * flows left out by tags.
 */
export function junitXml(results: FlowReport[], skipped: { file: string; name: string }[], secs: number): string {
  const failures = results.filter((r) => !r.ok).length;
  const cases = results.map((r) => {
    const open = `  <testcase classname="${xml(r.file)}" name="${xml(r.name)}" time="${r.secs.toFixed(3)}"`;
    if (r.ok) return `${open}/>`;
    const message = r.failedStep ? `step ${r.failedStep}: ${(r.error ?? "").split("\n")[0]}` : (r.error ?? "failed").split("\n")[0];
    const body = [r.error, r.crash && !r.error?.includes(r.crash) ? r.crash : "", r.artifacts?.length ? `artifacts: ${r.artifacts.join(", ")}` : ""]
      .filter(Boolean)
      .join("\n");
    return `${open}>\n    <failure message="${xml(message)}">${xml(body)}</failure>\n  </testcase>`;
  });
  for (const s of skipped) cases.push(`  <testcase classname="${xml(s.file)}" name="${xml(s.name)}" time="0"><skipped message="excluded by tags"/></testcase>`);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites tests="${results.length + skipped.length}" failures="${failures}" skipped="${skipped.length}" time="${secs.toFixed(3)}">`,
    `<testsuite name="droidreplay" tests="${results.length + skipped.length}" failures="${failures}" skipped="${skipped.length}" time="${secs.toFixed(3)}">`,
    ...cases,
    `</testsuite>`,
    `</testsuites>`,
    "",
  ].join("\n");
}
