import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAct } from "../dist/act.js";
import {
  flowName, fromCompact, hideVars, listFlows, loadFlow, patchSteps, Recorder, runFlow, saveFlow, substitute, toCompact, toRecorded, withWaits,
} from "../dist/flow.js";

/** Fake device that answers each step from `answer(step)`; records the batches it got. */
function fakeDevice(answer = () => ({ ok: true, out: "done" })) {
  const batches = [];
  return {
    batches,
    async run(steps, _stop, onResult) {
      batches.push(steps);
      const results = [];
      for (const s of steps) {
        const r = { op: s.op, ms: 1, ...(s.op === "observe" ? { ok: true, out: "app=x\n" } : answer(s)) };
        results.push(r);
        onResult?.(r);
        if (!r.ok) return { ok: false, ms: 1, results };
      }
      return { ok: true, ms: 1, results };
    },
    async shell(cmd) {
      return cmd.includes("resolve-activity") ? "com.app/.Main\n" : "";
    },
    async screenshot() {
      return Buffer.from("jpeg");
    },
  };
}

test("short YAML form round-trips", () => {
  for (const [compact, step] of [
    [{ tap: "Masuk" }, { op: "tap", text: "Masuk" }],
    [{ launch: "com.app" }, { op: "launch", package: "com.app" }],
    [{ sleep: 500 }, { op: "sleep", ms: 500 }],
    [{ type: { field: "Email", value: "a@b.c" } }, { op: "type", field: "Email", value: "a@b.c" }],
    [{ tap: { id: "login_btn" } }, { op: "tap", id: "login_btn" }],
    [{ observe: {} }, { op: "observe" }],
  ]) {
    assert.deepEqual(fromCompact(compact), step);
    assert.deepEqual(toCompact(step), compact);
  }
  assert.deepEqual(fromCompact({ op: "tap", text: "A" }), { op: "tap", text: "A" });
  assert.throws(() => fromCompact({ tap: "A", key: "back" }), /exactly one op/);
  assert.throws(() => fromCompact({ swipe: 3 }), /needs an object/);
});

test("recording replaces refs with the selector the agent reported", () => {
  assert.deepEqual(toRecorded({ op: "tap", ref: 4 }, { op: "tap", ok: true, ms: 1, sel: { id: "login_btn" } }), { op: "tap", id: "login_btn" });
  assert.deepEqual(
    toRecorded({ op: "type", ref: 2, value: "x" }, { op: "type", ok: true, ms: 1, sel: { text: "Email" } }),
    { op: "type", value: "x", field: "Email" },
  );
  assert.deepEqual(toRecorded({ op: "tap", ref: 9 }, { op: "tap", ok: true, ms: 1, out: "tapped 10,20" }), { op: "tap", x: 10, y: 20 });
  assert.deepEqual(toRecorded({ op: "tap", text: "OK", wait: 5000 }, { op: "tap", ok: true, ms: 1 }), { op: "tap", text: "OK" });
  for (const op of ["observe", "apps", "wait_idle"]) assert.equal(toRecorded({ op }, { op, ok: true, ms: 1 }), null);
});

test("act feeds only successful steps to the recorder", async () => {
  const rec = new Recorder("login");
  const d = fakeDevice((s) => (s.op === "wait_for" ? { ok: false, error: "not found" } : { ok: true, out: "done", sel: s.ref !== undefined ? { text: "Masuk" } : undefined }));
  await runAct(d, [{ op: "tap", ref: 3 }, { op: "observe" }, { op: "wait_for", text: "Beranda" }], { evidenceDir: tmpdir(), onSuccess: (s, r) => rec.add(s, r) });
  assert.deepEqual(rec.toFile(), { name: "login", steps: [{ tap: "Masuk" }] });
});

test("substitute fills vars and names every missing one", () => {
  assert.deepEqual(substitute([{ op: "type", value: "${email}" }], { email: "a@b.c" }), [{ op: "type", value: "a@b.c" }]);
  assert.throws(() => substitute([{ op: "type", value: "${a} ${b}" }], { a: "1" }), /missing variable\(s\): b/);
});

test("replays wait for elements but not for coordinates", () => {
  assert.deepEqual(withWaits([
    { op: "tap", text: "A" }, { op: "tap", x: 1, y: 2 }, { op: "type", value: "v" }, { op: "type", field: "F", value: "v" },
    { op: "wait_for", text: "B" }, { op: "tap", text: "C", wait: 100 },
  ], 3000), [
    { op: "tap", text: "A", wait: 3000 }, { op: "tap", x: 1, y: 2 }, { op: "type", value: "v" }, { op: "type", field: "F", value: "v", wait: 3000 },
    { op: "wait_for", text: "B", timeout: 3000 }, { op: "tap", text: "C", wait: 100 },
  ]);
});

test("runFlow passes, batches agent steps and saves evidence per run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "droidreplay-"));
  try {
    const d = fakeDevice();
    const flow = { name: "login", steps: [{ launch: "com.app" }, { tap: "Masuk" }, { type: { field: "Email", value: "${email}" } }, { screenshot: "done" }] };
    const r = await runFlow(d, flow, { vars: { email: "a@b.c" }, evidenceDir: dir });
    assert.equal(r.ok, true);
    assert.match(r.text, /✓ flow login passed: 4 steps/);
    assert.deepEqual(d.batches, [
      [{ op: "tap", text: "Masuk", wait: 5000 }, { op: "type", field: "Email", value: "a@b.c", wait: 5000 }],
      [{ op: "wait_idle", quietMs: 400, timeout: 3000 }], // screen settles before the screenshot
    ]);
    assert.match(r.evidenceDir, /login[/\\]\d{8}-\d{6}$/);
    assert.equal(await readFile(join(r.evidenceDir, "done.jpg"), "utf8"), "jpeg");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runFlow reports the failing step number and the screen", async () => {
  const d = fakeDevice((s) => (s.text === "Lanjut" ? { ok: false, error: 'not found: text="Lanjut"' } : { ok: true, out: "done" }));
  const r = await runFlow(d, { name: "f", steps: [{ tap: "Masuk" }, { tap: "Lanjut" }, { tap: "Selesai" }] }, { evidenceDir: tmpdir(), screenOnFailure: true });
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, 2);
  assert.match(r.text, /failed at step 2\/3 .*tap: Lanjut/);
  assert.match(r.text, /--- screen\napp=x/);
  assert.match(r.text, /index: 2/);
});

test("patch replaces or deletes one step", () => {
  const flow = { name: "f", steps: [{ tap: "A" }, { tap: "B" }, { tap: "C" }] };
  assert.deepEqual(patchSteps(flow, 2, [{ op: "tap", id: "b" }, { wait_for: "D" }]).steps, [{ tap: "A" }, { tap: { id: "b" } }, { wait_for: "D" }, { tap: "C" }]);
  assert.deepEqual(patchSteps(flow, 3, []).steps, [{ tap: "A" }, { tap: "B" }]);
  assert.throws(() => patchSteps(flow, 4, []), /index must be 1\.\.3/);
});

test("flows save to and load from YAML files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "droidreplay-"));
  try {
    const path = await saveFlow(dir, { name: "login ok", steps: [{ tap: "Masuk" }] });
    assert.equal(path, join(dir, "login-ok.yaml"));
    assert.match(await readFile(path, "utf8"), /- tap: Masuk/);
    assert.deepEqual((await loadFlow(dir, "login-ok")).flow, { name: "login ok", steps: [{ tap: "Masuk" }] });
    assert.deepEqual(await listFlows(dir), ["login-ok"]);
    await assert.rejects(loadFlow(dir, "nope"), /flow not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("flows save to and load from a path outside the flows folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "droidreplay-"));
  try {
    const target = join(dir, "scratch", "login.yaml");
    const path = await saveFlow(join(dir, "flows"), { name: "login", steps: [{ tap: "Masuk" }] }, target);
    assert.equal(path, target);
    assert.deepEqual((await loadFlow(join(dir, "flows"), target)).flow.steps, [{ tap: "Masuk" }]);
    assert.equal(flowName(target), "login");
    assert.equal(flowName("login ok"), "login-ok");
    // A plain name never leaves the flows folder.
    assert.equal(await saveFlow(join(dir, "flows"), { name: "..", steps: [] }), join(dir, "flows", "-.yaml"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("optional steps survive recording and the YAML round trip, and a skip passes the flow", async () => {
  const step = { op: "tap", text: "Lanjut ke aplikasi", optional: true };
  const recorded = toRecorded({ ...step, wait: 5000 }, { op: "tap", ok: true, ms: 1, out: "skipped (not found)" });
  assert.deepEqual(recorded, step);
  assert.deepEqual(fromCompact(toCompact(recorded)), step);

  // The agent reports a skipped optional step as ok, so the flow goes on.
  const d = fakeDevice((s) => (s.optional ? { ok: true, out: "skipped (not found: text=\"Lanjut ke aplikasi\")" } : { ok: true, out: "done" }));
  const run = await runFlow(d, { name: "ad", steps: [{ tap: { text: "Lanjut ke aplikasi", optional: true } }, { tap: "Home" }] }, { evidenceDir: tmpdir() });
  assert.equal(run.ok, true);
  assert.match(run.text, /1\. ✓ tap 1ms skipped/);
  assert.equal(d.batches[0][0].wait, 5000, "optional steps still wait for their element");
});

test("a flow's dismiss list goes to every step that waits for an element", async () => {
  const d = fakeDevice();
  await runFlow(d, { name: "ad", dismiss: ["Lanjut ke aplikasi", { id: "close" }], steps: [{ launch: "com.app" }, { tap: "Home" }, { wait_for: "Done" }, { key: "back" }] }, { evidenceDir: tmpdir() });
  const sent = d.batches.flat();
  const list = [{ text: "Lanjut ke aplikasi" }, { id: "close" }];
  assert.deepEqual(sent.find((s) => s.op === "tap").dismiss, list);
  assert.deepEqual(sent.find((s) => s.op === "wait_for").dismiss, list);
  assert.equal(sent.find((s) => s.op === "key").dismiss, undefined);
});

test("runFlow hands each step result over as it finishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "droidreplay-"));
  try {
    const seen = [];
    const flow = { name: "live", steps: [{ launch: "com.app" }, { tap: "A" }, { tap: "B" }, { screenshot: "end" }] };
    const run = await runFlow(fakeDevice(), flow, { evidenceDir: dir, onStep: (i, r) => seen.push(`${i}:${r.op}:${r.ok}`) });
    assert.deepEqual(seen, ["0:launch:true", "1:tap:true", "2:tap:true", "3:screenshot:true"]);
    assert.ok(run.ok && run.shots && /^\d+\.\d$/.test(run.secs));

    seen.length = 0;
    const failed = await runFlow(fakeDevice((s) => (s.text === "B" ? { ok: false, error: "not found" } : { ok: true, out: "done" })), flow, { evidenceDir: dir, onStep: (i, r) => seen.push(`${i}:${r.ok}`) });
    assert.deepEqual(seen, ["0:true", "1:true", "2:false"]);
    assert.equal(failed.failedStep, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recording with vars saves ${var}, never the value", () => {
  const vars = { PIN: "482913", PHONE: "81234567890", X: "7" };
  const rec = new Recorder("login", vars);
  const ok = { op: "type", ok: true, ms: 1 };
  // The model typed the real values (act already substituted them, or it typed them itself).
  rec.add({ op: "type", field: "PIN", value: "482913" }, ok);
  rec.add({ op: "type", field: "Phone", value: "+6281234567890", submit: true }, ok);
  rec.add({ op: "tap", text: "7" }, { op: "tap", ok: true, ms: 1 });
  assert.deepEqual(rec.toFile().steps, [
    { type: { field: "PIN", value: "${PIN}" } },
    { type: { field: "Phone", value: "+62${PHONE}", submit: true } },
    { tap: "7" }, // values under 3 chars are left alone
  ]);
  assert.deepEqual(hideVars({ op: "tap", text: "a" }, {}), { op: "tap", text: "a" });
  // A longer value wins over one it contains.
  assert.deepEqual(hideVars({ op: "type", value: "123456" }, { A: "123", B: "123456" }), { op: "type", value: "${B}" });
});

test("run_flow: when gates an inline block, checked once without waiting", async () => {
  const shown = new Set(["Dismiss"]);
  const d = fakeDevice((s) =>
    s.op === "wait_for" && s.timeout === 0
      ? shown.has(s.text) ? { ok: true, out: "found" } : { ok: false, error: `timeout waiting for text="${s.text}"` }
      : { ok: true, out: "done" },
  );
  const flow = {
    name: "gate",
    steps: [
      { run_flow: { when: { visible: "Dismiss" }, steps: [{ tap: "Dismiss" }] } },
      { run_flow: { when: { visible: "Allow" }, steps: [{ tap: "Allow" }] } },
      { tap: "Home" },
    ],
  };
  const run = await runFlow(d, flow, { evidenceDir: tmpdir() });
  assert.ok(run.ok, run.text);
  assert.match(run.text, /1\. ✓ run_flow \d+ms ran 1 steps/);
  assert.match(run.text, /2\. ✓ run_flow \d+ms skipped \(when not met\)/);
  const taps = d.batches.flat().filter((s) => s.op === "tap").map((s) => s.text);
  assert.deepEqual(taps, ["Dismiss", "Home"]);
  assert.ok(d.batches.flat().some((s) => s.op === "wait_for" && s.text === "Allow" && s.timeout === 0));
});

test("run_flow: a file next to the flow, its vars on top of the caller's, and inner failures named", async () => {
  const dir = await mkdtemp(join(tmpdir(), "droidreplay-"));
  try {
    await mkdir(join(dir, "shared"));
    await writeFile(join(dir, "shared", "pin.yaml"), 'name: pin\nsteps:\n  - tap: {text: "${PIN}", below: "${PROMPT}"}\n  - tap: "${PIN}x"\n');
    const flow = { name: "login", steps: [{ run_flow: { file: "shared/pin", vars: { PROMPT: "Enter PIN" } } }] };
    const d = fakeDevice((s) => (s.text === "123456x" ? { ok: false, error: 'not found: text="123456x"' } : { ok: true, out: "done" }));
    const run = await runFlow(d, flow, { evidenceDir: dir, dir, vars: { PIN: "123456" } });
    assert.equal(run.failedStep, 1);
    assert.match(run.text, /run_flow \d+ms step 2 \(tap\) failed: not found: text="123456x"/);
    assert.deepEqual(d.batches.flat()[0], { op: "tap", text: "123456", below: "Enter PIN", wait: 5000 });

    // A flow that runs itself stops instead of looping forever.
    await writeFile(join(dir, "loop.yaml"), "name: loop\nsteps:\n  - run_flow: {file: loop.yaml}\n");
    const loop = await runFlow(fakeDevice(), { name: "l", steps: [{ run_flow: { file: "loop.yaml" } }] }, { evidenceDir: dir, dir });
    assert.match(loop.text, /nested more than 8 deep/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("substitute leaves a run_flow's own steps for later, with its own vars", () => {
  const out = substitute([{ op: "run_flow", vars: { A: "${X}" }, steps: [{ tap: "${A}" }] }], { X: "1" });
  assert.deepEqual(out, [{ op: "run_flow", vars: { A: "1" }, steps: [{ tap: "${A}" }] }]);
});

test("repeat: times, while checked before each round, a cap for while alone, inner failures named", async () => {
  let left = 3; // "Next" shows on three onboarding pages
  const d = fakeDevice((s) => {
    if (s.op === "wait_for" && s.timeout === 0) return left > 0 ? { ok: true, out: "found" } : { ok: false, error: 'timeout waiting for text="Next"' };
    if (s.op === "tap" && s.text === "Next") left--;
    return { ok: true, out: "done" };
  });
  const run = await runFlow(d, { name: "onboarding", steps: [{ repeat: { times: 6, while: { visible: "Next" }, steps: [{ tap: "Next" }] } }] }, { evidenceDir: tmpdir() });
  assert.match(run.text, /✓ repeat \d+ms ran 3 times/);

  const twice = await runFlow(fakeDevice(), { name: "t", steps: [{ repeat: { times: 2, steps: [{ scroll: "down" }] } }] }, { evidenceDir: tmpdir() });
  assert.match(twice.text, /ran 2 times/);

  const always = fakeDevice((s) => (s.op === "wait_for" ? { ok: true, out: "found" } : { ok: true, out: "done" }));
  const stuck = await runFlow(always, { name: "s", steps: [{ repeat: { while: { visible: "Spinner" }, steps: [{ key: "back" }] } }] }, { evidenceDir: tmpdir() });
  assert.match(stuck.text, /while still true after 100 rounds/);

  const bad = fakeDevice((s) => (s.text === "B" ? { ok: false, error: "not found" } : { ok: true, out: "done" }));
  const failed = await runFlow(bad, { name: "f", steps: [{ repeat: { times: 2, steps: [{ tap: "A" }, { tap: "B" }] } }] }, { evidenceDir: tmpdir() });
  assert.match(failed.text, /round 1, step 2 \(tap\) failed: not found/);
});
