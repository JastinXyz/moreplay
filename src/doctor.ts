import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { adbPath, Device, VERSION } from "./device.js";

const exec = promisify(execFile);

// Processes that hold (or fight over) the single UiAutomation connection.
const CONFLICTS: [RegExp, string][] = [
  [/com\.mobilenext\.mobilecli\.DeviceServer/, "mobilecli / mobile-mcp device server"],
  [/io\.appium\.uiautomator2/, "Appium UiAutomator2 server"],
  [/dev\.mobile\.maestro/, "Maestro driver"],
  [/com\.github\.uiautomator|com\.wetest\.uia2/, "uiautomator2 (openatx)"],
  [/uiautomator (dump|runtest|events)/, "uiautomator command"],
];

const XIAOMI = /xiaomi|redmi|poco/i;

type Level = "ok" | "warn" | "fail";
const mark: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗" };

/** Checks everything droidreplay needs and prints one line per check. Returns the exit code. */
export async function doctor(): Promise<number> {
  let failed = false;
  const report = (level: Level, msg: string, hint?: string) => {
    if (level === "fail") failed = true;
    console.log(`${mark[level]} ${msg}`);
    if (hint) console.log(`    ${hint}`);
  };

  console.log(`droidreplay ${VERSION} doctor\n`);

  const adb = adbPath();
  try {
    const { stdout } = await exec(adb, ["version"]);
    report("ok", `adb: ${stdout.split("\n")[0].trim()} (${adb})`);
  } catch {
    report("fail", "adb not found", "Install Android platform-tools, or set ANDROID_HOME.");
    return 1;
  }

  const { stdout: devOut } = await exec(adb, ["devices"]);
  const devices = devOut
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2);
  for (const [serial, state] of devices.filter((d) => d[1] !== "device")) {
    const hint =
      state === "unauthorized"
        ? "Unlock the phone and accept the USB debugging prompt."
        : "Reconnect the cable, or run `adb kill-server`.";
    report("warn", `device ${serial} is ${state}`, hint);
  }

  const device = new Device();
  let serial: string;
  try {
    serial = await device.getSerial();
    report("ok", `device: ${serial}`);
  } catch (e) {
    report("fail", (e as Error).message);
    return 1;
  }

  const props = await device.shell(
    "getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.mi.os.version.name; getprop ro.miui.ui.version.name",
  );
  const [maker, model, release, sdkStr, hyperos, miui] = props.split("\n").map((s) => s.trim());
  const sdk = Number(sdkStr);
  const skin = hyperos ? `HyperOS ${hyperos}` : miui ? `MIUI ${miui}` : "";
  if (sdk < 26) {
    report("fail", `Android ${release} (API ${sdk}) is too old`, "droidreplay needs Android 8.0 (API 26) or newer.");
    return 1;
  }
  report(sdk >= 33 ? "ok" : "warn", `${maker} ${model}, Android ${release} (API ${sdk})${skin ? `, ${skin}` : ""}`,
    sdk >= 33 ? undefined : "Below API 33 taps wait for animations to finish (~1 s each).");

  const ps = await device.shell("ps -A -o ARGS 2>/dev/null || ps");
  const found = CONFLICTS.filter(([re]) => re.test(ps)).map(([, name]) => name);
  if (found.length) {
    report("fail", `UiAutomation is likely taken by: ${found.join(", ")}`, "Stop that tool first; only one UiAutomation client can run per device.");
  } else {
    report("ok", "no other UiAutomation client running");
  }

  try {
    const t0 = Date.now();
    await device.ensureAgent();
    report("ok", `agent ${await device.agentVersion()} started in ${Date.now() - t0} ms`);

    const times: number[] = [];
    let lines = 0;
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      const r = await device.run([{ op: "observe" }]);
      times.push(Date.now() - t);
      lines = (r.results[0].out ?? "").split("\n").length - 1;
    }
    times.sort((a, b) => a - b);
    report("ok", `observe: ${times[1]} ms median, ${lines} lines on the current screen`);

    // KEYCODE_UNKNOWN (0) checks the inject permission without doing anything visible.
    const r = await device.run([{ op: "key", key: "0" }]);
    if (r.ok) {
      report("ok", "input injection allowed");
    } else {
      report("fail", `input injection failed: ${r.results[0].error}`,
        XIAOMI.test(maker) ? "Xiaomi: enable Developer options > USB debugging (Security settings), then reboot." : undefined);
    }
  } catch (e) {
    report("fail", (e as Error).message);
  } finally {
    device.stop();
  }

  if (!failed && XIAOMI.test(maker)) {
    report("ok", "Xiaomi device: injection works, so 'USB debugging (Security settings)' is already on");
  }
  console.log(failed ? "\nSome checks failed." : "\nAll good.");
  return failed ? 1 : 0;
}
