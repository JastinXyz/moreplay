import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAct, fmt, screenshotPath, withActWaits } from "../dist/act.js";

/** Fake device: records every call, answers agent steps with ok unless the op is in `fail`. */
function fakeDevice({ fail = [], shell = {} } = {}) {
  const calls = [];
  return {
    calls,
    async run(steps) {
      calls.push({ run: steps.map((s) => s.op) });
      const results = [];
      for (const s of steps) {
        const ok = !fail.includes(s.op);
        results.push(ok ? { op: s.op, ok, ms: 1, out: s.op === "observe" ? "app=x\n@0 Button \"OK\" [1,1] tap\n" : "done" } : { op: s.op, ok, ms: 1, error: "not found" });
        if (!ok) return { ok: false, ms: 1, results };
      }
      return { ok: true, ms: 1, results };
    },
    async shell(cmd) {
      // Every failure looks for a crash; tests about other calls leave that lookup out.
      if (!cmd.includes("-b crash") || shell.recordCrashLookup) calls.push({ shell: cmd });
      for (const [k, v] of Object.entries(shell)) if (cmd.includes(k)) return v;
      return "";
    },
    async screenshot() {
      calls.push({ screenshot: true });
      return Buffer.from("jpeg");
    },
    async install(apk, grantAll) {
      calls.push({ install: apk, grantAll });
      return shell.install ?? "Performing Streamed Install\nSuccess\n";
    },
  };
}

const opts = { evidenceDir: join(tmpdir(), "droidreplay-test-unused"), observeAfter: false };

test("consecutive agent ops go to the device in one request", async () => {
  const d = fakeDevice();
  await runAct(d, [{ op: "tap", text: "A" }, { op: "wait_for", text: "B" }, { op: "key", key: "back" }], opts);
  assert.deepEqual(d.calls, [{ run: ["tap", "wait_for", "key"] }]);
});

test("host ops split the batch and run in order", async () => {
  const d = fakeDevice({ shell: { "resolve-activity": "com.app/.Main\n" } });
  const out = await runAct(d, [{ op: "tap", x: 1, y: 2 }, { op: "launch", package: "com.app" }, { op: "wait_for", text: "Home" }], opts);
  assert.deepEqual(d.calls.map((c) => Object.keys(c)[0]), ["run", "shell", "shell", "run"]);
  assert.match(out, /✓ launch \d+ms launched com\.app\/\.Main/);
});

test("stops at the first failure and skips later steps", async () => {
  const d = fakeDevice({ fail: ["wait_for"] });
  const out = await runAct(d, [{ op: "tap", text: "A" }, { op: "wait_for", text: "B" }, { op: "launch", package: "com.app" }], opts);
  assert.match(out, /✗ wait_for 1ms not found/);
  assert.ok(!d.calls.some((c) => c.shell), "launch must not run after a failure");
});

test("appends the screen after the batch by default", async () => {
  const d = fakeDevice();
  const out = await runAct(d, [{ op: "tap", text: "A" }], { ...opts, observeAfter: undefined });
  assert.deepEqual(d.calls.at(-1), { run: ["wait_idle", "observe"] });
  assert.match(out, /--- screen\napp=x/);
});

test("no extra observe when the batch already ends with observe", async () => {
  const d = fakeDevice();
  await runAct(d, [{ op: "tap", text: "A" }, { op: "observe" }], { ...opts, observeAfter: undefined });
  assert.equal(d.calls.length, 1);
});

test("rejects package names that could inject shell commands", async () => {
  const d = fakeDevice();
  const out = await runAct(d, [{ op: "launch", package: "com.app; reboot" }], opts);
  assert.match(out, /✗ launch \d+ms invalid package name/);
  assert.equal(d.calls.length, 0);
});

test("apps filters and sorts third-party packages", async () => {
  const d = fakeDevice({ shell: { "pm list packages": "package:com.b.cards\npackage:com.a.cards\npackage:org.other\n" } });
  const out = await runAct(d, [{ op: "apps", filter: "cards" }], opts);
  assert.match(out, /com\.a\.cards com\.b\.cards$/);
});

test("screenshot step saves an evidence file with a safe name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "droidreplay-"));
  try {
    const d = fakeDevice();
    const out = await runAct(d, [{ op: "screenshot", name: "TC 03: login ok" }], { evidenceDir: dir, observeAfter: false });
    const path = join(dir, "TC_03_login_ok.jpg");
    assert.match(out, new RegExp(`saved ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(await readFile(path, "utf8"), "jpeg");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("screenshot step saves to a path the caller chose", async () => {
  const dir = await mkdtemp(join(tmpdir(), "droidreplay-"));
  try {
    const target = join(dir, "scratch", "login");
    const out = await runAct(fakeDevice(), [{ op: "screenshot", name: target }], { evidenceDir: join(dir, "evidence"), observeAfter: false });
    assert.match(out, /saved .*scratch\/login\.jpg/);
    assert.equal(await readFile(`${target}.jpg`, "utf8"), "jpeg");
    assert.equal(screenshotPath("/ev", join(dir, "a.jpeg")), join(dir, "a.jpeg"));
    assert.equal(screenshotPath("/ev", ".."), "/ev/...jpg");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fmt puts multi-line output below the status line", () => {
  assert.equal(fmt({ op: "tap", ok: true, ms: 5, out: "tapped 1,2" }), "✓ tap 5ms tapped 1,2");
  assert.equal(fmt({ op: "observe", ok: true, ms: 5, out: "a\nb\n" }), "✓ observe 5ms\na\nb");
  assert.equal(fmt({ op: "tap", ok: false, ms: 5, error: "nope" }), "✗ tap 5ms nope");
});

test("selector steps after the first wait briefly for their element; refs and points do not", () => {
  const out = withActWaits([
    { op: "tap", text: "Keuangan" },
    { op: "tap", text: "Tabungan" },
    { op: "type", field: "Cari", value: "x" },
    { op: "tap", ref: 3 },
    { op: "tap", x: 1, y: 2 },
    { op: "tap", text: "A", wait: 0 },
  ]);
  assert.deepEqual(out.map((s) => s.wait), [undefined, 3000, 3000, undefined, undefined, 0]);
});

test("recording gets the steps as given, without the implicit wait", async () => {
  const seen = [];
  await runAct(fakeDevice(), [{ op: "tap", text: "A" }, { op: "tap", text: "B" }], { ...opts, onSuccess: (s) => seen.push(s) });
  assert.deepEqual(seen, [{ op: "tap", text: "A" }, { op: "tap", text: "B" }]);
});

test("clear_app wipes the app with pm clear and fails loudly when it cannot", async () => {
  const ok = fakeDevice({ shell: { "pm clear": "Success\n" } });
  assert.match(await runAct(ok, [{ op: "clear_app", package: "com.app" }], opts), /✓ clear_app \d+ms cleared com\.app/);
  assert.deepEqual(ok.calls, [{ shell: "pm clear com.app" }, { shell: "dumpsys package com.app" }]);

  const denied = fakeDevice({ shell: { "pm clear": "Failed\n" } });
  assert.match(await runAct(denied, [{ op: "clear_app", package: "com.app" }, { op: "tap", text: "A" }], opts), /✗ clear_app \d+ms pm clear com\.app: Failed$/);
  assert.deepEqual(denied.calls, [{ shell: "pm clear com.app" }]); // stopped there

  // pm exits non-zero for an unknown package; the error keeps pm's answer, not adb's command line.
  const missing = fakeDevice();
  missing.shell = async () => { throw new Error("Command failed: adb -s X shell pm clear com.app\nFailed"); };
  assert.match(await runAct(missing, [{ op: "clear_app", package: "com.app" }], opts), /✗ clear_app \d+ms pm clear com\.app: Failed$/);

  const bad = fakeDevice();
  assert.match(await runAct(bad, [{ op: "clear_app", package: "com.app; rm -rf /" }], opts), /invalid package name/);
  assert.deepEqual(bad.calls, []);
});

test("a target given only by position still gets the implicit act wait", () => {
  assert.deepEqual(withActWaits([{ op: "tap", text: "A" }, { op: "tap", below: "Enter your PIN", text: "1" }, { op: "tap", above: "Finance" }]), [
    { op: "tap", text: "A" },
    { op: "tap", below: "Enter your PIN", text: "1", wait: 3000 },
    { op: "tap", above: "Finance", wait: 3000 },
  ]);
});

test("an agent batch gets time for the waits it asks for", async () => {
  const { stepBudget } = await import("../dist/device.js");
  assert.equal(stepBudget([{ op: "tap", text: "A" }]), 0);
  assert.equal(stepBudget([{ op: "tap", text: "A", wait: 3000 }, { op: "wait_for", text: "B" }, { op: "sleep", ms: 500 }]), 3000 + 5000 + 500);
  assert.equal(stepBudget([{ op: "tap", x: 1, y: 2, settle: 3000 }]), 3000);
  assert.equal(stepBudget([{ op: "wait_for", text: "B", timeout: 20000 }, { op: "scroll", dir: "down", max: 4 }, { op: "long_press", text: "C" }]), 20000 + 6000 + 700);
});

test("install_app installs with adb (-g on grant) and refuses a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "droidreplay-"));
  try {
    const apk = join(dir, "app.apk");
    await writeFile(apk, "apk");
    const d = fakeDevice();
    assert.match(await runAct(d, [{ op: "install_app", path: apk, grant: true }], opts), /✓ install_app \d+ms installed app\.apk/);
    assert.deepEqual(d.calls, [{ install: apk, grantAll: true }]);

    const bad = fakeDevice({ shell: { install: "Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]" } });
    assert.match(await runAct(bad, [{ op: "install_app", path: apk }], opts), /install failed: Failure \[INSTALL_FAILED_USER_RESTRICTED/);

    const none = fakeDevice();
    assert.match(await runAct(none, [{ op: "install_app", path: join(dir, "nope.apk") }], opts), /install_app: no file at/);
    assert.deepEqual(none.calls, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uninstall_app, open_link and launch args build safe adb commands", async () => {
  const d = fakeDevice({ shell: { "pm uninstall": "Success\n", "resolve-activity": "com.app/.Main\n", "am start -W": "Status: ok\n" } });
  const out = await runAct(d, [
    { op: "uninstall_app", package: "com.app" },
    { op: "open_link", url: "myapp://item/1?name=it's", package: "com.app" },
    { op: "launch", package: "com.app", args: { user: "a b", count: 3, ratio: 1.5, debug: true } },
  ], opts);
  assert.match(out, /uninstalled com\.app/);
  assert.match(out, /opened myapp:\/\/item\/1\?name=it's/);
  const shells = d.calls.map((c) => c.shell).filter(Boolean);
  assert.ok(shells.includes("am start -W -a android.intent.action.VIEW -d 'myapp://item/1?name=it'\\''s' -p com.app"), shells.join("\n"));
  assert.ok(shells.includes("am start -W -n 'com.app/.Main' --es user 'a b' --ei count 3 --ef ratio 1.5 --ez debug true"), shells.join("\n"));

  const err = fakeDevice({ shell: { "am start -W": "Error: Activity not started, unable to resolve Intent\n" } });
  assert.match(await runAct(err, [{ op: "open_link", url: "nope://x" }], opts), /✗ open_link \d+ms open_link nope:\/\/x: Error: Activity not started/);
  assert.match(await runAct(fakeDevice({ shell: { "resolve-activity": "com.app/.Main\n" } }), [{ op: "launch", package: "com.app", args: { "a;b": 1 } }], opts), /launch arg name not allowed/);
});

test("permissions grants and revokes short names, and grant all takes what the app requests", async () => {
  const d = fakeDevice();
  assert.match(await runAct(d, [{ op: "permissions", package: "com.app", grant: ["CAMERA"], revoke: "android.permission.RECORD_AUDIO" }], opts), /com\.app \+CAMERA -RECORD_AUDIO/);
  assert.deepEqual(d.calls.map((c) => c.shell), ["pm grant com.app android.permission.CAMERA 2>&1; true", "pm revoke com.app android.permission.RECORD_AUDIO 2>&1; true"]);

  const dump = "Packages:\n  requested permissions:\n    android.permission.INTERNET\n    android.permission.CAMERA\n  install permissions:\n";
  const all = fakeDevice({ shell: { "dumpsys package": dump, "INTERNET": "Exception: not a changeable permission type" } });
  assert.match(await runAct(all, [{ op: "permissions", package: "com.app", grant: "all" }], opts), /com\.app \+CAMERA$/m);

  const refused = fakeDevice({ shell: { "pm grant": "Exception occurred while executing 'grant': Unknown permission: X" } });
  assert.match(await runAct(refused, [{ op: "permissions", package: "com.app", grant: ["X"] }], opts), /pm grant android\.permission\.X: Exception/);
  assert.match(await runAct(fakeDevice(), [{ op: "permissions", package: "com.app", grant: ["CAMERA; reboot"] }], opts), /permission name not allowed/);
});

test("a failed step carries the app's crash; passing steps never look for one", async () => {
  const crash = [
    "--------- beginning of crash",
    "E/AndroidRuntime( 4242): FATAL EXCEPTION: main",
    "E/AndroidRuntime( 4242): Process: com.app, PID: 4242",
    "E/AndroidRuntime( 4242): java.lang.NullPointerException: user was null",
    "E/AndroidRuntime( 4242): \tat com.app.Home.render(Home.kt:42)",
    "E/AndroidRuntime( 4242): \tat com.app.Home.onCreate(Home.kt:10)",
    "",
  ].join("\n");
  const d = fakeDevice({ fail: ["wait_for"], shell: { "-b crash": crash, recordCrashLookup: true } });
  const out = await runAct(d, [{ op: "tap", text: "Open" }, { op: "wait_for", text: "Home" }], opts);
  assert.match(out, /✗ wait_for \d+ms\nnot found\napp crashed: FATAL EXCEPTION: main\nProcess: com\.app, PID: 4242\njava\.lang\.NullPointerException: user was null\n  at com\.app\.Home\.render\(Home\.kt:42\)/);

  const ok = fakeDevice({ shell: { recordCrashLookup: true } });
  await runAct(ok, [{ op: "tap", text: "Open" }], opts);
  assert.ok(!ok.calls.some((c) => c.shell?.includes("-b crash")));
});

test("logs: one app's lines by pid, folded repeats, the crash buffer when it is not running", async () => {
  const d = fakeDevice({ shell: { pidof: "4242\n", "--pid=4242": "W/Net( 4242): retry\nW/Net( 4242): retry\nW/Net( 4242): retry\nE/App( 4242): " + "x".repeat(300) + "\n" } });
  const out = await runAct(d, [{ op: "logs", package: "com.app", level: "w", since: "2m", lines: 10 }], opts);
  assert.match(out, /com\.app, level W\+, last 120s: 2 line\(s\)\nW\/Net\( 4242\): retry \(x3\)\nE\/App\( 4242\): x{220,}…/);
  assert.ok(d.calls.some((c) => c.shell?.includes(`logcat -d -v brief -T "$(($(date +%s)-120)).000" --pid=4242 '*:W'`)));

  const gone = fakeDevice({ shell: { pidof: "", recordCrashLookup: true } });
  assert.match(await runAct(gone, [{ op: "logs", package: "com.app" }], opts), /com\.app \(not running; crash buffer\), level W\+, last 60s: nothing/);
  assert.ok(gone.calls.some((c) => c.shell?.startsWith("logcat -d -b crash")));
  assert.match(await runAct(fakeDevice(), [{ op: "logs", level: "loud" }], opts), /level must be one of V D I W E F/);
  assert.match(await runAct(fakeDevice(), [{ op: "logs", since: "yesterday" }], opts), /since must look like 30s/);
});

test("the tools that hold UiAutomation are named from a ps listing", async () => {
  const { uiautomationHolders } = await import("../dist/device.js");
  const ps = [
    "app_process / com.genymobile.scrcpy.Server 5.0.1",
    "app_process / com.mobilenext.mobilecli.DeviceServer --idle-timeout-ms=1800000",
    "uiautomator dump /sdcard/u.xml",
  ].join("\n");
  assert.deepEqual(uiautomationHolders(ps), ["mobilecli's device server (mobile-mcp starts it again while a session runs)", "uiautomator command"]);
  assert.deepEqual(uiautomationHolders("app_process / com.genymobile.scrcpy.Server"), []); // scrcpy does not use UiAutomation
});

test("clear_app waits until Android has revoked the runtime permissions it resets", async () => {
  const { runtimeGranted } = await import("../dist/act.js");
  const dump = (g) => `Packages:\n    User 0:\n      runtime permissions:\n        android.permission.CAMERA: granted=${g}, flags=[ ]\n        android.permission.POST_NOTIFICATIONS: granted=false\n    install permissions:\n      android.permission.INTERNET: granted=true\n`;
  assert.equal(runtimeGranted(dump(true)), 1);
  assert.equal(runtimeGranted(dump(false)), 0); // install permissions do not count

  let reads = 0;
  const d = fakeDevice({ shell: { "pm clear": "Success\n" } });
  const shell = d.shell;
  d.shell = async (cmd) => (cmd.startsWith("dumpsys") ? dump(++reads < 3) : shell(cmd));
  assert.match(await runAct(d, [{ op: "clear_app", package: "com.app" }], opts), /cleared com\.app/);
  assert.equal(reads, 3); // granted, granted, then revoked
});
