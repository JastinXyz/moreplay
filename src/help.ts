import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Reference topics, shipped as docs/reference/<topic>.md (the website uses the same files). */
export const HELP_TOPICS = {
  steps: "every step act and flow files take",
  selectors: "text, id, regex, position (below/above/...), index, state, childOf",
  flows: "flow files: recording, vars, optional, dismiss, run_flow, repeat, failures",
  cli: "moreplay doctor / run / export / import",
} as const;

const REFERENCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "reference");

/** One topic's reference, or the topic list when none (or an unknown one) is given. */
export async function help(topic?: string): Promise<string> {
  const list = Object.entries(HELP_TOPICS).map(([t, what]) => `- ${t}: ${what}`).join("\n");
  if (!topic) return `Reference topics (flow {action: "help", name: <topic>}):\n${list}`;
  if (!(topic in HELP_TOPICS)) throw new Error(`no help topic "${topic}"; topics:\n${list}`);
  return readFile(join(REFERENCE_DIR, `${topic}.md`), "utf8");
}

/** Sent once when a client connects (MCP `instructions`): how to work with the tools. */
export const INSTRUCTIONS = `moreplay drives an Android phone over adb.

Work loop: observe once, then act with every step you can batch in ONE call; act returns the new screen, so no extra observe is needed. Prefer text or id selectors; refs (@12) and coordinates are a last resort, and refs only last until the next observe.

To make a task repeatable: flow record {name, vars} before acting, flow save after. Give passwords and PINs as vars and write \${name} in act, so the saved file never holds them. Replay with flow run (no model needed), or \`npx moreplay run <name>\` in a terminal. When a replay fails, flow patch the reported step and run again.

Screenshots are saved as files; use show:true only when you need the pixels, and screenshot {refs} to see unlabeled icons.

Full reference: flow {action: "help", name: "steps" | "selectors" | "flows" | "cli"}. Read "selectors" before writing position (below/above/leftOf/rightOf) or nested selectors by hand, and "flows" before editing a flow file.

Only one tool can control the phone's UI at a time. If moreplay says another tool holds it, ask the user to stop that tool.`;
