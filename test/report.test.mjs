import { test } from "node:test";
import assert from "node:assert/strict";
import { describeStep, Reporter } from "../dist/report.js";

test("a repeat line says how many rounds ran", () => {
  const rep = new Reporter([{ op: "repeat", times: 3, while: { visible: "A" }, steps: [{ tap: "A" }] }], false);
  assert.match(rep.step(0, { op: "repeat", ok: true, ms: 5, out: "ran 0 times" }), /ran 0x$/);
  assert.match(rep.step(0, { op: "repeat", ok: true, ms: 5, out: "ran 2 times" }), /ran 2x$/);
});

test("steps are labelled from the flow as written", () => {
  for (const [step, label] of [
    [{ op: "launch", package: "com.app" }, "launch com.app"],
    [{ op: "clear_app", package: "com.app" }, "clear_app com.app"],
    [{ op: "tap", text: "Sign in" }, 'tap "Sign in"'],
    [{ op: "tap", id: "btn_ok" }, "tap #btn_ok"],
    [{ op: "tap", x: 10, y: 20 }, "tap 10,20"],
    [{ op: "type", field: "Password", value: "${password}", submit: true }, 'type "${password}" into "Password" + enter'],
    [{ op: "scroll", dir: "down", until: { text: "Logout" } }, 'scroll down until "Logout"'],
    [{ op: "scroll", dir: "up", until: "/e2e .*/" }, 'scroll up until "/e2e .*/"'],
    [{ op: "wait_for", text: "42" }, 'wait_for "42"'],
    [{ op: "key", key: "back" }, "key back"],
    [{ op: "run_flow", file: "shared/pin.yaml" }, "run_flow shared/pin.yaml"],
    [{ op: "run_flow", when: { true: "${CLEAR == 'true'}" }, steps: [{ clear_app: "com.app" }] }, "run_flow 1 steps when ${CLEAR == 'true'}"],
    [{ op: "tap", text: "Save", index: 1 }, 'tap "Save" [1]'],
    [{ op: "tap", text: "Wi-Fi", checked: false }, 'tap "Wi-Fi" !checked'],
    [{ op: "tap", containsChild: "Settings" }, 'tap containsChild "Settings"'],
    [{ op: "tap", x: "50%", y: "90%" }, "tap 50%,90%"],
    [{ op: "repeat", times: 6, while: { visible: { id: "next" } }, steps: [{ tap: { id: "next" } }] }, "repeat 1 steps 6x while visible #next"],
    [{ op: "hide_keyboard" }, "hide_keyboard"],
    [{ op: "install_app", path: "build/app.apk", grant: true }, "install_app build/app.apk"],
    [{ op: "open_link", url: "myapp://item/1" }, "open_link myapp://item/1"],
    [{ op: "permissions", package: "com.app", grant: ["CAMERA"], revoke: "RECORD_AUDIO" }, "permissions com.app +CAMERA -RECORD_AUDIO"],
    [{ op: "run_flow", when: { visible: "Dismiss" }, steps: [{ tap: "Dismiss" }] }, 'run_flow 1 steps when visible "Dismiss"'],
    [{ op: "tap", text: "1", below: "Enter your PIN" }, 'tap "1" below "Enter your PIN"'],
    [{ op: "tap", above: "Finance", leftOf: { id: "menu_more" } }, 'tap above "Finance" leftOf #menu_more'],
    [{ op: "screenshot", name: "home" }, "screenshot home"],
  ]) assert.equal(describeStep(step), label);
});

test("plain output: aligned steps, the error under a failure, not-run steps, a badge", () => {
  const rep = new Reporter([{ op: "launch", package: "com.app" }, { op: "tap", text: "Sign in" }, { op: "wait_for", text: "Home" }], false);
  assert.match(rep.header("flows/login.yaml"), /RUN  flows\/login\.yaml  3 steps/);
  assert.equal(rep.step(0, { op: "launch", ok: true, ms: 234, out: "launched" }), "  ✓ launch com.app    234 ms");
  assert.equal(rep.step(1, { op: "tap", ok: false, ms: 5003, error: 'not found: text="Sign in"' }), '  ✗ tap "Sign in"    5003 ms\n      not found: text="Sign in"');
  assert.deepEqual(rep.notRun(2), ['  ○ wait_for "Home"  not run']);
  assert.match(rep.footer(false, "5.4", { failedStep: 2 }), /FAIL  step 2 of 3 failed after 5\.4 s/);
  assert.match(rep.footer(true, "1.2", { evidence: "ev/x" }), /PASS  3 steps in 1\.2 s\nEvidence  ev\/x/);
  assert.match(rep.step(1, { op: "tap", ok: true, ms: 9, out: "skipped (not found)" }), /– tap "Sign in" +skipped/);
});

test("color output wraps marks and badges in ANSI codes", () => {
  const rep = new Reporter([{ op: "tap", text: "A" }], true);
  assert.match(rep.step(0, { op: "tap", ok: true, ms: 5, out: "ok" }), /\x1b\[32m✓\x1b\[0m/);
  assert.match(rep.footer(true, "0.1"), /\x1b\[30;42m PASS \x1b\[0m/);
});

test("FORCE_COLOR=0 turns colors off, other values on; NO_COLOR wins", async () => {
  const { useColor } = await import("../dist/report.js");
  const saved = { FORCE_COLOR: process.env.FORCE_COLOR, NO_COLOR: process.env.NO_COLOR };
  const tty = { isTTY: true };
  try {
    delete process.env.NO_COLOR;
    for (const [v, want] of [["0", false], ["false", false], ["1", true], ["3", true]]) {
      process.env.FORCE_COLOR = v;
      assert.equal(useColor({ isTTY: false }), want, `FORCE_COLOR=${v}`);
    }
    delete process.env.FORCE_COLOR;
    assert.equal(useColor(tty), true);
    assert.equal(useColor({ isTTY: false }), false);
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "1";
    assert.equal(useColor(tty), false);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("suite summary: totals, skipped by tags, and the flows that failed", async () => {
  const { suiteSummary } = await import("../dist/report.js");
  assert.equal(
    suiteSummary([{ name: "a.yaml", ok: true }, { name: "b.yaml", ok: false, failedStep: 3 }], 1, "9.5", false),
    "\nFAIL  3 flows: 1 passed, 1 failed, 1 skipped by tags in 9.5 s\n  ✗ b.yaml (step 3)",
  );
  assert.equal(suiteSummary([{ name: "a.yaml", ok: true }, { name: "c.yaml", ok: true }], 0, "2.0", false), "\nPASS  2 flows: 2 passed in 2.0 s");
});

test("JUnit XML: a testcase per flow, failures with step, crash and artifacts, skipped by tags, escaped", async () => {
  const { junitXml } = await import("../dist/report.js");
  const out = junitXml(
    [
      { file: "flows/a.yaml", name: "open", ok: true, secs: 1.2 },
      {
        file: "flows/b.yaml",
        name: "login <ok>",
        ok: false,
        secs: 5.5,
        failedStep: 3,
        error: 'not found: text="Home"',
        crash: "app crashed: FATAL EXCEPTION: main",
        artifacts: ["ev/failed-step-3.jpg", "ev/failed-step-3.txt"],
      },
    ],
    [{ file: "flows/c.yaml", name: "slow" }],
    6.7,
  );
  assert.match(out, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites tests="3" failures="1" skipped="1" time="6.700">/);
  assert.match(out, /<testcase classname="flows\/a.yaml" name="open" time="1.200"\/>/);
  assert.match(out, /<testcase classname="flows\/b.yaml" name="login &lt;ok&gt;" time="5.500">\n    <failure message="step 3: not found: text=&quot;Home&quot;">not found: text=&quot;Home&quot;\napp crashed: FATAL EXCEPTION: main\nartifacts: ev\/failed-step-3.jpg, ev\/failed-step-3.txt<\/failure>/);
  assert.match(out, /<testcase classname="flows\/c.yaml" name="slow" time="0"><skipped message="excluded by tags"\/><\/testcase>/);
});
