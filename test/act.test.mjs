import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAct, fmt } from "../dist/act.js";

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
      calls.push({ shell: cmd });
      for (const [k, v] of Object.entries(shell)) if (cmd.includes(k)) return v;
      return "";
    },
    async screenshot() {
      calls.push({ screenshot: true });
      return Buffer.from("jpeg");
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
    const out = await runAct(d, [{ op: "screenshot", name: "TC 03/login ok" }], { evidenceDir: dir, observeAfter: false });
    const path = join(dir, "TC_03_login_ok.jpg");
    assert.match(out, new RegExp(`saved ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(await readFile(path, "utf8"), "jpeg");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fmt puts multi-line output below the status line", () => {
  assert.equal(fmt({ op: "tap", ok: true, ms: 5, out: "tapped 1,2" }), "✓ tap 5ms tapped 1,2");
  assert.equal(fmt({ op: "observe", ok: true, ms: 5, out: "a\nb\n" }), "✓ observe 5ms\na\nb");
  assert.equal(fmt({ op: "tap", ok: false, ms: 5, error: "nope" }), "✗ tap 5ms nope");
});
