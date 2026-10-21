import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

const DEVICE_JAR = "/data/local/tmp/droidreplay.jar";
const AGENT_CLASS = "dev.droidreplay.agent.Main";
const DEVICE_PORT = 9070;

export interface StepResult {
  op: string;
  ok: boolean;
  ms: number;
  out?: string;
  error?: string;
}

export interface RunResult {
  ok: boolean;
  ms: number;
  results: StepResult[];
}

function adbPath(): string {
  const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (home) {
    const p = join(home, "platform-tools", "adb");
    if (existsSync(p)) return p;
  }
  return "adb";
}

function jarPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "..", "assets", "droidreplay.jar"), join(here, "..", "agent", "build", "droidreplay.jar")]) {
    if (existsSync(p)) return p;
  }
  throw new Error("droidreplay.jar not found; run `npm run build:agent`");
}

/** One connected Android device plus the agent process running on it. */
export class Device {
  private readonly adb = adbPath();
  private serial?: string;
  private port?: number;
  private agent?: ChildProcess;
  private agentLog = "";
  private starting?: Promise<void>;

  async shell(cmd: string): Promise<string> {
    const serial = await this.getSerial();
    const { stdout } = await exec(this.adb, ["-s", serial, "shell", cmd], { maxBuffer: 16 << 20 });
    return stdout;
  }

  async getSerial(): Promise<string> {
    if (this.serial) return this.serial;
    const wanted = process.env.ANDROID_SERIAL;
    const { stdout } = await exec(this.adb, ["devices"]);
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

  private async ping(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/ping`, { signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async startAgent(): Promise<void> {
    const serial = await this.getSerial();
    this.agent?.kill();
    // A leftover agent would still hold the single UiAutomation slot.
    // "[n]" keeps pkill from matching (and killing) the shell that runs it.
    await this.shell(`pkill -f '${AGENT_CLASS.slice(0, -1)}[${AGENT_CLASS.slice(-1)}]'; true`);
    await exec(this.adb, ["-s", serial, "push", jarPath(), DEVICE_JAR]);
    const { stdout } = await exec(this.adb, ["-s", serial, "forward", "tcp:0", `tcp:${DEVICE_PORT}`]);
    this.port = Number(stdout.trim());

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
    const log = this.agentLog.trim().split("\n").slice(-6).join("\n");
    if (/already registered|UiAutomationService/.test(log)) {
      throw new Error(
        "another tool holds the UiAutomation connection (Appium, Maestro, uiautomator2, mobilecli, `uiautomator dump`). Stop it and retry.\n" + log,
      );
    }
    throw new Error(`agent did not start:\n${log}`);
  }

  async run(steps: object[], stopOnError = true): Promise<RunResult> {
    await this.ensureAgent();
    const res = await fetch(`http://127.0.0.1:${this.port}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps, stopOnError }),
    });
    if (!res.ok) throw new Error(`agent error ${res.status}: ${await res.text()}`);
    return (await res.json()) as RunResult;
  }

  async screenshot(max: number, quality: number): Promise<Buffer> {
    await this.ensureAgent();
    const res = await fetch(`http://127.0.0.1:${this.port}/screenshot?max=${max}&q=${quality}`);
    if (!res.ok) throw new Error(`screenshot failed: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }

  stop(): void {
    this.agent?.kill();
    this.agent = undefined;
    if (this.serial && this.port) {
      try {
        // Sync on purpose: this also runs from the process "exit" handler.
        execFileSync(this.adb, ["-s", this.serial, "forward", "--remove", `tcp:${this.port}`], { stdio: "ignore" });
      } catch {
        // Device already gone; nothing to clean up.
      }
      this.port = undefined;
    }
  }
}
