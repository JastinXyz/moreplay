import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseAllDocuments } from "yaml";
import { fromMaestro, toMaestro } from "../dist/maestro.js";

const commands = (yaml) => parseAllDocuments(yaml).map((d) => d.toJS());

test("export maps steps to Maestro commands", () => {
  const { out, skipped } = toMaestro({
    name: "login",
    dismiss: ["Nanti"],
    steps: [
      { launch: "com.app" },
      { tap: "Masuk" },
      { tap: { id: "close", optional: true } },
      { tap: { x: 10, y: 20 } },
      { tap: { ref: 4 } },
      { type: { field: "Email", value: "${email}", submit: true } },
      { type: { value: "x", append: true } },
      { key: "back" },
      { key: "enter" },
      { scroll: "down" },
      { scroll: "up" },
      { scroll: { dir: "down", until: { text: "Keluar" } } },
      { wait_for: { text: "Beranda", timeout: 8000 } },
      { wait_gone: "Memuat" },
      { screenshot: "home" },
      { observe: {} },
      { sleep: 500 },
      { stop_app: "com.other" },
    ],
  });
  const [header, cmds] = commands(out);
  assert.deepEqual(header, { appId: "com.app", name: "login" });
  assert.deepEqual(cmds, [
    "launchApp",
    { tapOn: "Masuk" },
    { tapOn: { id: "close", optional: true } },
    { tapOn: { point: "10,20" } },
    { tapOn: "Email" },
    "eraseText",
    { inputText: "${email}" },
    { pressKey: "Enter" },
    { inputText: "x" },
    "back",
    { pressKey: "Enter" },
    "scroll",
    { swipe: { direction: "DOWN" } },
    { scrollUntilVisible: { element: { text: "Keluar" }, direction: "DOWN" } },
    { extendedWaitUntil: { visible: { text: "Beranda" }, timeout: 8000 } },
    { extendedWaitUntil: { notVisible: { text: "Memuat" } } },
    { takeScreenshot: "home" },
    { stopApp: "com.other" },
  ]);
  assert.equal(skipped.length, 3);
  assert.match(skipped[0], /^dismiss/);
  assert.match(skipped[1], /step 5: .*ref/);
  assert.match(skipped[2], /step 17: .*sleep/);
});

test("export needs an appId when the flow launches nothing", () => {
  assert.throws(() => toMaestro({ name: "x", steps: [{ tap: "A" }] }), /--app-id/);
  assert.match(toMaestro({ name: "x", steps: [{ tap: "A" }] }, "com.app").out, /appId: com.app/);
});

test("import maps Maestro commands to steps", () => {
  const { out, skipped } = fromMaestro(`appId: com.app
name: login
---
- launchApp
- tapOn: Masuk
- tapOn: {id: close, optional: true}
- tapOn: {point: "10,20"}
- tapOn: {point: "50%,50%"}
- tapOn: {text: Simpan, below: Nama}
- tapOn: Email
- eraseText
- inputText: \${email}
- inputText: lagi
- pressKey: Enter
- back
- scroll
- swipe: {direction: DOWN}
- scrollUntilVisible: {element: Keluar, direction: DOWN}
- extendedWaitUntil: {visible: Beranda, timeout: 8000}
- assertNotVisible: Memuat
- waitForAnimationToEnd
- takeScreenshot: home
- runFlow: other.yaml
- stopApp
`);
  assert.equal(out.name, "login");
  assert.deepEqual(out.steps, [
    { launch: "com.app" },
    { tap: "Masuk" },
    { tap: { id: "close", optional: true } },
    { tap: { x: 10, y: 20 } },
    { tap: "Email" },
    { type: "${email}" },
    { type: { value: "lagi", append: true } },
    { key: "enter" },
    { key: "back" },
    { scroll: "down" },
    { scroll: "up" },
    { scroll: { dir: "down", until: { text: "Keluar" } } },
    { wait_for: { text: "Beranda", timeout: 8000 } },
    { wait_gone: "Memuat" },
    { wait_idle: {} },
    { screenshot: "home" },
    { stop_app: "com.app" },
  ]);
  assert.equal(skipped.length, 3);
  assert.match(skipped[0], /command 5: .*only absolute/);
  assert.match(skipped[1], /command 6: .*selector key below/);
  assert.match(skipped[2], /command 20: .*runFlow/);
});

test("export then import keeps the flow", () => {
  const flow = {
    name: "roundtrip",
    steps: [{ launch: "com.app" }, { tap: "Masuk" }, { type: "a" }, { key: "back" }, { wait_gone: "Memuat" }, { screenshot: "done" }],
  };
  assert.deepEqual(fromMaestro(toMaestro(flow).out).out, flow);
});

test("import and export CLIs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dr-maestro-"));
  const run = (...args) => promisify(execFile)("node", ["dist/index.js", ...args], { env: { ...process.env, DROIDREPLAY_FLOWS_DIR: dir } });
  try {
    const src = join(dir, "maestro-login.yaml");
    await writeFile(src, "appId: com.app\n---\n- launchApp\n- tapOn: Masuk\n- runFlow: x.yaml\n");
    const imp = await run("import", src, "--name", "login");
    assert.match(imp.stdout, /saved .*login\.yaml \(2 steps\)/);
    assert.match(imp.stderr, /runFlow/);
    assert.match(await readFile(join(dir, "login.yaml"), "utf8"), /tap: Masuk/);
    await assert.rejects(run("import", src, "--name", "login"), (e) => e.code === 1 && /exists/.test(e.stderr));
    const exp = await run("export", "login");
    assert.match(exp.stdout, /appId: com.app\n.*---\n- launchApp\n- tapOn: Masuk/s);
    await assert.rejects(run("export"), (e) => e.code === 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
