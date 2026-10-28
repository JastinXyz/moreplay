import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { runHolder, runLockPath } from "../dist/device.js";

// A `moreplay run` marks the device busy so an MCP server does not take it mid-replay.
test("a run lock counts only while its process is alive and is not ours", async () => {
  const serial = `test-${process.pid}`;
  const path = runLockPath(serial);
  try {
    assert.equal(runHolder(serial), undefined, "no lock");
    writeFileSync(path, String(process.pid));
    assert.equal(runHolder(serial), undefined, "our own lock");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
    writeFileSync(path, String(child.pid));
    assert.equal(runHolder(serial), child.pid, "a live run");
    child.kill();
    await new Promise((r) => child.once("exit", r));
    assert.equal(runHolder(serial), undefined, "a killed run leaves a stale lock");
  } finally {
    rmSync(path, { force: true });
  }
});
