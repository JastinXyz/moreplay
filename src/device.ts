import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

const DEVICE_JAR = "/data/local/tmp/moreplay.jar";
const AGENT_CLASS = "dev.moreplay.agent.Main";
const DEVICE_PORT = 9070;

// Every adb call and agent request is bounded: a wedged adb server or agent would otherwise
// hang the MCP client with no answer at all.
const ADB_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 120_000;
const IMAGE_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 300_000;
const RUN_BASE_MS = 30_000;

// Processes that hold (or fight over) the single UiAutomation connection.
const UIAUTOMATION_HOLDERS: [RegExp, string][] = [
  [/com\.mobilenext\.mobilecli\.DeviceServer/, "mobilecli's device server (mobile-mcp starts it again while a session runs)"],
  [/io\.appium\.uiautomator2/, "Appium UiAutomator2 server"],
  [/dev\.mobile\.maestro/, "Maestro driver"],
  [/com\.github\.uiautomator|com\.wetest\.uia2/, "uiautomator2 (openatx)"],
  [/uiautomator (dump|runtest|events)/, "uiautomator command"],
];

/** Names of the tools in a `ps -A -o ARGS` listing that hold UiAutomation. */
export function uiautomationHolders(ps: string): string[] {
  return UIAUTOMATION_HOLDERS.filter(([re]) => re.test(ps)).map(([, name]) => name);
}

/**
 * How long a batch may take on the device: the waits, timeouts and sleeps it asks for, plus
 * defaults for steps that wait on their own (wait_for/wait_gone/wait_idle 5 s, scroll 1.5 s a swipe).
 */
export function stepBudget(steps: object[]): number {
  let ms = 0;
  for (const raw of steps) {
    const s = raw as Record<string, unknown>;
    const num = (k: string, d = 0) => (typeof s[k] === "number" ? (s[k] as number) : d);
    if (s.op === "wait_for" || s.op === "wait_gone" || s.op === "wait_idle") ms += num("timeout", 5000);
    else if (s.op === "sleep" || s.op === "long_press") ms += num("ms", s.op === "sleep" ? 0 : 700);
    else if (s.op === "scroll") ms += num("max", 10) * 1500;
    ms += num("wait") + num("settle");
  }
  return ms;
}

export interface StepResult {
  op: string;
  ok: boolean;
  ms: number;
  out?: string;
  error?: string;
  /** Stable selector of the element acted on (agent fills it for targeted steps). */
  sel?: Record<string, string>;
}

export interface RunResult {
  ok: boolean;
  ms: number;
  results: StepResult[];
}

const here = dirname(fileURLToPath(import.meta.url));

export const VERSION: string = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;

export function adbPath(): string {
  const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (home) {
    const p = join(home, "platform-tools", "adb");
    if (existsSync(p)) return p;
  }
  return "adb";
}

function jarPath(): string {
  for (const p of [join(here, "..", "assets", "moreplay.jar"), join(here, "..", "agent", "build", "moreplay.jar")]) {
    if (existsSync(p)) return p;
  }
  throw new Error("moreplay.jar not found; run `npm run build:agent`");
}

/** One connected Android device plus the agent process running on it. */
/**
 * Who uses the device. Only one agent can hold it, and starting one stops any other, so:
 * a `run` (moreplay run) marks the device as busy while it replays, and a `server` (the MCP
 * server, doctor) refuses to take it from a run instead of silently killing it. A run still
 * takes the device from an idle server, which starts its agent again on its next call.
 */
export type DeviceRole = "run" | "server";

/** A lock file per device, holding the pid of the `moreplay run` that is using it. */
export function runLockPath(serial: string): string {
  return join(tmpdir(), `moreplay-run-${serial.replace(/[^\w.-]/g, "_")}.lock`);
}

/** The pid of a live `moreplay run` (other than this process) holding the device, if any. */
export function runHolder(serial: string): number | undefined {
  let pid: number;
  try {
    pid = Number(readFileSync(runLockPath(serial), "utf8").trim());
  } catch {
    return undefined;
  }
  if (!pid || pid === process.pid) return undefined;
  try {
    process.kill(pid, 0); // throws when no such process: a lock left by a killed run
    return pid;
  } catch {
    return undefined;
  }
}

export class Device {
  constructor(private readonly role: DeviceRole = "server") {}

  private readonly adb = adbPath();
  private serial?: string;
  private port?: number;
  private agent?: ChildProcess;
  private agentLog = "";
  private starting?: Promise<void>;

  /** Runs adb with a time limit; a timeout names the command instead of hanging. */
  private async adbRun(args: string[], timeout = ADB_TIMEOUT_MS): Promise<string> {
    try {
      const { stdout } = await exec(this.adb, args, { maxBuffer: 16 << 20, timeout });
      return stdout;
    } catch (e) {
      const err = e as Error & { killed?: boolean; signal?: string };
      if (err.killed || err.signal === "SIGTERM") {
        throw new Error(`adb ${args.filter((a) => a !== "-s" && a !== this.serial).join(" ").slice(0, 80)} timed out after ${timeout / 1000} s (is the device responsive? try \`adb devices\`)`);
      }
      throw err;
    }
  }

  async shell(cmd: string, timeout = ADB_TIMEOUT_MS): Promise<string> {
    const serial = await this.getSerial();
    return this.adbRun(["-s", serial, "shell", cmd], timeout);
  }

  async install(apk: string, grantAll: boolean): Promise<string> {
    const serial = await this.getSerial();
    return this.adbRun(["-s", serial, "install", "-r", ...(grantAll ? ["-g"] : []), apk], INSTALL_TIMEOUT_MS).catch(
      (e: Error) => e.message,
    );
  }

  async getSerial(): Promise<string> {
    if (this.serial) return this.serial;
    const wanted = process.env.ANDROID_SERIAL;
    const stdout = await this.adbRun(["devices"]);
    const ready = stdout
      .split("\n")
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p[1] === "device")
      .map((p) => p[0]);
    if (wanted) {
      if (!ready.includes(wanted)) throw new Error(`ANDROID_SERIAL=${wanted} is not connected (have: ${ready.join(", ") || "none"})`);
      this.serial = wanted;
    } else if (ready.length === 1) {
      this.serial = ready[0];
    } else if (ready.length === 0) {
      throw new Error("no Android device connected (check `adb devices` and USB debugging)");
    } else {
      throw new Error(`several devices connected (${ready.join(", ")}); set ANDROID_SERIAL`);
    }
    return this.serial;
  }

  /** Pushes and starts the agent if it is not already answering. */
  async ensureAgent(): Promise<void> {
    if (this.port && (await this.ping())) return;
    this.starting ??= this.startAgent().finally(() => (this.starting = undefined));
    return this.starting;
  }

  /** True only when our agent answers with the version this server was built with. */
  private async ping(): Promise<boolean> {
    return (await this.agentVersion()) === VERSION;
  }

  async agentVersion(): Promise<string | undefined> {
    if (!this.port) return undefined;
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/ping`, { signal: AbortSignal.timeout(1000) });
      if (!res.ok) return undefined;
      return (await res.text()).replace(/^pong ?/, "") || "unknown";
    } catch {
      return undefined;
    }
  }

  /** Pushes the jar only when the device copy differs (md5), which saves a push per start. */
  private async pushJar(serial: string): Promise<void> {
    const local = jarPath();
    const md5 = createHash("md5").update(readFileSync(local)).digest("hex");
    const remote = (await this.shell(`md5sum ${DEVICE_JAR} 2>/dev/null; true`)).split(/\s+/)[0];
    if (remote !== md5) await this.adbRun(["-s", serial, "push", local, DEVICE_JAR], PUSH_TIMEOUT_MS);
  }

  private async startAgent(): Promise<void> {
    const serial = await this.getSerial();
    if (this.role === "run") {
      writeFileSync(runLockPath(serial), String(process.pid));
    } else {
      const pid = runHolder(serial);
      if (pid) throw new Error(`device busy: \`moreplay run\` (pid ${pid}) is replaying flows on it; try again when it finishes`);
    }
    this.agent?.kill();
    // A leftover agent would still hold the single UiAutomation slot.
    // "[n]" keeps pkill from matching (and killing) the shell that runs it.
    await this.shell(`pkill -f '${AGENT_CLASS.slice(0, -1)}[${AGENT_CLASS.slice(-1)}]'; true`);
    await this.pushJar(serial);
    // After an agent crash the old forward still points at DEVICE_PORT; a new one would leak it.
    if (!this.port) {
      const stdout = await this.adbRun(["-s", serial, "forward", "tcp:0", `tcp:${DEVICE_PORT}`]);
      this.port = Number(stdout.trim());
    }

    this.agentLog = "";
    const child = spawn(this.adb, ["-s", serial, "shell", `CLASSPATH=${DEVICE_JAR} app_process / ${AGENT_CLASS} ${DEVICE_PORT}`]);
    child.stdout.on("data", (d) => (this.agentLog += d));
    child.stderr.on("data", (d) => (this.agentLog += d));
    child.on("exit", () => {
      if (this.agent === child) this.agent = undefined;
    });
    this.agent = child;

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await this.ping()) return;
      if (!this.agent) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const answered = await this.agentVersion();
    if (answered && answered !== VERSION) {
      throw new Error(`agent on the device answered version ${answered}, expected ${VERSION}`);
    }
    const log = this.agentLog.trim().split("\n").slice(-6).join("\n");
    // The usual reason is another automation tool on the device; say which, since the agent's
    // own output is often just "Killed".
    const holders = uiautomationHolders(await this.shell("ps -A -o ARGS 2>/dev/null; true").catch(() => ""));
    if (holders.length) {
      throw new Error(`another tool holds the UiAutomation connection: ${holders.join(", ")}. Stop it and retry.\n${log}`);
    }
    if (/already registered|UiAutomationService/.test(log)) {
      throw new Error(
        "another tool holds the UiAutomation connection (Appium, Maestro, uiautomator2, mobilecli, `uiautomator dump`). Stop it and retry.\n" + log,
      );
    }
    throw new Error(`agent did not start:\n${log}`);
  }

  /** Runs steps in one request. With `onResult`, the agent streams each step's result as it finishes. */
  async run(steps: object[], stopOnError = true, onResult?: (r: StepResult) => void): Promise<RunResult> {
    await this.ensureAgent();
    const budget = RUN_BASE_MS + stepBudget(steps);
    // Aborted by the time budget, or as soon as the agent dies mid-request (another moreplay
    // process started its own, which stops ours, and our adb shell exits): no waiting it out.
    const ctrl = new AbortController();
    let why: "timeout" | "died" | undefined;
    const timer = setTimeout(() => ((why ??= "timeout"), ctrl.abort()), budget);
    const agent = this.agent;
    const onExit = () => ((why ??= "died"), ctrl.abort());
    agent?.once("exit", onExit);
    try {
      return await this.request(steps, stopOnError, onResult, ctrl.signal);
    } catch (e) {
      // The stream often breaks just before the adb shell's exit is seen: give it a moment.
      if (!why && agent && agent.exitCode === null && agent.signalCode === null) {
        await new Promise((r) => {
          const t = setTimeout(r, 500);
          agent.once("exit", () => (clearTimeout(t), r(undefined)));
        });
      }
      if (why === "died" || (agent && (agent.exitCode !== null || agent.signalCode !== null))) {
        throw new Error("the agent stopped in the middle of this request: another moreplay process (an MCP server, `moreplay run`) or another automation tool took the device");
      }
      if (why !== "timeout") throw e;
      // The agent is wedged; drop it so the next call starts a fresh one.
      this.agent?.kill();
      this.agent = undefined;
      throw new Error(`the agent did not answer within ${Math.round(budget / 1000)} s; it will be restarted on the next call`);
    } finally {
      clearTimeout(timer);
      agent?.off("exit", onExit);
    }
  }

  private async request(steps: object[], stopOnError: boolean, onResult: ((r: StepResult) => void) | undefined, signal: AbortSignal): Promise<RunResult> {
    const res = await fetch(`http://127.0.0.1:${this.port}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps, stopOnError, stream: !!onResult }),
      signal,
    });
    if (!res.ok) throw new Error(`agent error ${res.status}: ${await res.text()}`);
    if (!onResult) return (await res.json()) as RunResult;

    // NDJSON: one line per step, then {"done": true, ok, ms[, error]}.
    const results: StepResult[] = [];
    let end: { ok: boolean; ms: number; error?: string } | undefined;
    let buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.done) {
          end = msg;
        } else {
          results.push(msg as StepResult);
          onResult(msg as StepResult);
        }
      }
    }
    if (!end) throw new Error("agent closed the stream early");
    if (end.error) throw new Error(`agent error: ${end.error}`);
    return { ok: end.ok, ms: end.ms, results };
  }

  async screenshot(max: number, quality: number): Promise<Buffer> {
    await this.ensureAgent();
    const res = await fetch(`http://127.0.0.1:${this.port}/screenshot?max=${max}&q=${quality}`, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`screenshot failed: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Crops of @refs from the latest observe, side by side in one JPEG. */
  async crops(refs: number[], size = 96): Promise<Buffer> {
    await this.ensureAgent();
    const res = await fetch(`http://127.0.0.1:${this.port}/crops?refs=${refs.join(",")}&size=${size}&q=80`, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`crops failed: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }

  stop(): void {
    this.agent?.kill();
    this.agent = undefined;
    if (this.role === "run" && this.serial) {
      try {
        if (readFileSync(runLockPath(this.serial), "utf8").trim() === String(process.pid)) unlinkSync(runLockPath(this.serial));
      } catch {
        // No lock to remove.
      }
    }
    if (this.serial && this.port) {
      try {
        // Sync on purpose: this also runs from the process "exit" handler.
        execFileSync(this.adb, ["-s", this.serial, "forward", "--remove", `tcp:${this.port}`], { stdio: "ignore", timeout: 5000 });
      } catch {
        // Device already gone; nothing to clean up.
      }
      this.port = undefined;
    }
  }
}
