import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = (...args) => promisify(execFile)("node", ["dist/index.js", ...args]);

test("--version prints the package version", async () => {
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal((await run("--version")).stdout.trim(), version);
});

test("--help lists the commands", async () => {
  const { stdout } = await run("--help");
  assert.match(stdout, /droidreplay doctor/);
});

test("unknown commands exit with 2", async () => {
  await assert.rejects(run("nope"), (e) => e.code === 2 && /unknown command: nope/.test(e.stderr));
});
