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
  assert.match(stdout, /moreplay doctor/);
});

test("unknown commands exit with 2", async () => {
  await assert.rejects(run("nope"), (e) => e.code === 2 && /unknown command: nope/.test(e.stderr));
});

test("run: usage errors exit 2; a folder with nothing left after tags exits 1 before touching a device", async () => {
  await assert.rejects(run("run"), (e) => e.code === 2 && /usage: moreplay run/.test(e.stderr));
  await assert.rejects(run("run", "x", "--nope"), (e) => e.code === 2 && /unknown option: --nope/.test(e.stderr));
  await assert.rejects(run("run", "x", "--include-tags"), (e) => e.code === 2 && /--include-tags needs a value/.test(e.stderr));
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "moreplay-"));
  try {
    await writeFile(join(dir, "slow.yaml"), "name: slow\ntags: [slow]\nsteps: []\n");
    await assert.rejects(run("run", dir, "--exclude-tags", "slow"), (e) => e.code === 1 && /no flows to run \(1 found, 1 skipped by tags\)/.test(e.stderr));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
