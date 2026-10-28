import { test } from "node:test";
import assert from "node:assert/strict";
import { describeStep, Reporter } from "../dist/report.js";

test("steps are labelled from the flow as written", () => {
  for (const [step, label] of [
    [{ op: "launch", package: "com.app" }, "launch com.app"],
    [{ op: "clear_app", package: "com.app" }, "clear_app com.app"],
    [{ op: "tap", text: "Sign in" }, 'tap "Sign in"'],
    [{ op: "tap", id: "btn_ok" }, "tap #btn_ok"],
    [{ op: "tap", x: 10, y: 20 }, "tap 10,20"],
    [{ op: "type", field: "Password", value: "${password}", submit: true }, 'type "${password}" into "Password" + enter'],
    [{ op: "scroll", dir: "down", until: { text: "Logout" } }, 'scroll down until "Logout"'],
    [{ op: "wait_for", text: "42" }, 'wait_for "42"'],
    [{ op: "key", key: "back" }, "key back"],
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
