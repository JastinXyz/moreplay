#!/usr/bin/env node
import { VERSION } from "./device.js";

const HELP = `moreplay ${VERSION}: fast Android MCP server

Usage:
  moreplay            run the MCP server on stdio (what MCP clients start)
  moreplay doctor     check adb, the device and the agent, then exit
  moreplay run <flow|folder>... [--var key=value]... [--evidence dir]
                  [--include-tags a,b] [--exclude-tags c] [--junit report.xml]
                         replay flows (names in .moreplay/flows, .yaml paths, or every
                         .yaml in a folder) without a model; exit 0 when all pass, 1 otherwise
  moreplay export <flow> [--app-id package] [--out file]
                         print a flow as Maestro YAML (steps with no counterpart go to stderr)
  moreplay import <maestro.yaml> [--name flow-name] [--out file.yaml]
                         save a Maestro flow (default .moreplay/flows/<name>.yaml)
  moreplay --version

Env:
  ANDROID_SERIAL             device to use when several are connected
`;

const cmd = process.argv[2];
if (!cmd) {
  const { startServer } = await import("./server.js");
  await startServer();
} else if (cmd === "doctor") {
  const { doctor } = await import("./doctor.js");
  process.exit(await doctor());
} else if (cmd === "run") {
  const { runCli } = await import("./run-cli.js");
  process.exit(await runCli(process.argv.slice(3)));
} else if (cmd === "export" || cmd === "import") {
  const { exportCli, importCli } = await import("./maestro-cli.js");
  process.exit(await (cmd === "export" ? exportCli : importCli)(process.argv.slice(3)));
} else if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
} else if (cmd === "--help" || cmd === "-h") {
  console.log(HELP);
} else {
  console.error(`unknown command: ${cmd}\n\n${HELP}`);
  process.exit(2);
}
