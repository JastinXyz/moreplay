#!/usr/bin/env node
import { VERSION } from "./device.js";

const HELP = `droidreplay ${VERSION}: fast Android MCP server

Usage:
  droidreplay            run the MCP server on stdio (what MCP clients start)
  droidreplay doctor     check adb, the device and the agent, then exit
  droidreplay --version

Env:
  ANDROID_SERIAL             device to use when several are connected
  DROIDREPLAY_EVIDENCE_DIR   where screenshots are saved (default ./evidence)
`;

const cmd = process.argv[2];
if (!cmd) {
  const { startServer } = await import("./server.js");
  await startServer();
} else if (cmd === "doctor") {
  const { doctor } = await import("./doctor.js");
  process.exit(await doctor());
} else if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
} else if (cmd === "--help" || cmd === "-h") {
  console.log(HELP);
} else {
  console.error(`unknown command: ${cmd}\n\n${HELP}`);
  process.exit(2);
}
