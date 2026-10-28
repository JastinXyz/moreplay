import { parseAllDocuments, stringify } from "yaml";
import { RELATIVE_KEYS, type Step } from "./act.js";
import { fromCompact, toCompact, type FlowFile } from "./flow.js";

/**
 * Converts flows to and from Maestro YAML (a header with appId, `---`, then commands).
 * Anything with no counterpart is left out and listed in `skipped`, so nothing is lost silently.
 * `${var}` passes through both ways: Maestro reads it from `-e var=...`.
 */
export interface Converted<T> {
  out: T;
  skipped: string[];
}

type Cmd = string | Record<string, unknown>;

// droidreplay scrolls name where the content goes; Maestro swipes name where the finger goes.
const SWIPE_FOR_SCROLL: Record<string, string> = { down: "UP", up: "DOWN", right: "LEFT", left: "RIGHT" };
const SCROLL_FOR_SWIPE = Object.fromEntries(Object.entries(SWIPE_FOR_SCROLL).map(([k, v]) => [v, k]));
const KEY_TO_MAESTRO: Record<string, string> = { home: "Home", enter: "Enter", delete: "Backspace", tab: "Tab" };
const KEY_FROM_MAESTRO: Record<string, string> = { home: "home", enter: "enter", backspace: "delete", tab: "tab", back: "back" };

const brief = (v: unknown) => JSON.stringify(v);

// Maestro reads every text as a regex; droidreplay only when written "/like this/".
// ${var} placeholders are neither escaped nor counted as regex.
const PLACEHOLDER = /(\$\{\w+\})/;
const REGEX_CHARS = /[|*+?()[\]{}^$\\]/;

/** droidreplay text -> Maestro text: "/re/" as is, plain text escaped so Maestro matches it literally. */
function maestroText(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (v.length > 2 && v.startsWith("/") && v.endsWith("/")) return v.slice(1, -1);
  return v
    .split(PLACEHOLDER)
    .map((part, i) => (i % 2 ? part : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
}

/** Maestro text -> droidreplay text: "/.../" when it uses regex beyond "." (a lone "." is usually just a dot). */
function ourText(v: string): string {
  const bare = v.split(PLACEHOLDER).filter((_, i) => i % 2 === 0).join("");
  return REGEX_CHARS.test(bare) ? `/${v}/` : v;
}

/** droidreplay target -> Maestro selector; null for refs, which only exist in one session. */
function toSelector(s: Record<string, unknown>): Record<string, unknown> | null {
  if ("ref" in s) return null;
  const sel: Record<string, unknown> = {};
  if ("x" in s && "y" in s) sel.point = `${s.x},${s.y}`;
  // Maestro's text matches content-desc too.
  if ("text" in s) sel.text = maestroText(s.text);
  else if ("desc" in s) sel.text = maestroText(s.desc);
  else if ("field" in s) sel.text = maestroText(s.field);
  if ("id" in s) sel.id = s.id;
  if ("index" in s) sel.index = s.index;
  // Same names on both sides; an anchor is plain text or a selector of its own.
  for (const k of RELATIVE_KEYS) {
    const a = s[k];
    if (a === undefined) continue;
    if (a && typeof a === "object") {
      const inner = toSelector(a as Record<string, unknown>);
      if (!inner) return null;
      sel[k] = inner;
    } else sel[k] = maestroText(a);
  }
  return sel;
}

/** `tapOn: Masuk` when the selector is plain text, else the object form. */
function selectorCmd(name: string, sel: Record<string, unknown>, optional: boolean): Cmd {
  const keys = Object.keys(sel);
  if (!optional && keys.length === 1 && keys[0] === "text") return { [name]: sel.text };
  return { [name]: optional ? { ...sel, optional: true } : sel };
}

function stepToMaestro(s: Step, appId: string): Cmd[] | null {
  const optional = s.optional === true;
  const targeted = (name: string) => {
    const sel = toSelector(s);
    return sel && Object.keys(sel).length ? [selectorCmd(name, sel, optional)] : null;
  };
  switch (s.op) {
    case "launch":
      return [s.package === appId ? "launchApp" : { launchApp: { appId: s.package } }];
    case "stop_app":
      return [s.package === appId ? "stopApp" : { stopApp: s.package }];
    case "clear_app":
      return [s.package === appId ? "clearState" : { clearState: s.package }];
    case "tap":
      return targeted("tapOn");
    case "long_press":
      return targeted("longPressOn");
    case "type": {
      const sel = toSelector(s);
      if (sel === null) return null;
      const cmds: Cmd[] = Object.keys(sel).length ? [selectorCmd("tapOn", sel, false)] : [];
      // Maestro types at the cursor; droidreplay replaces the text unless append is set.
      if (s.append !== true) cmds.push("eraseText");
      cmds.push({ inputText: String(s.value ?? "") });
      if (s.submit === true) cmds.push({ pressKey: "Enter" });
      return cmds;
    }
    case "key": {
      const k = String(s.key).toLowerCase();
      if (k === "back") return ["back"];
      return KEY_TO_MAESTRO[k] ? [{ pressKey: KEY_TO_MAESTRO[k] }] : null;
    }
    case "scroll": {
      const dir = String(s.dir ?? "down");
      if (s.until && typeof s.until === "object") {
        const sel = toSelector(s.until as Record<string, unknown>);
        return sel ? [{ scrollUntilVisible: { element: sel, direction: dir.toUpperCase() } }] : null;
      }
      if (dir === "down") return ["scroll"];
      return SWIPE_FOR_SCROLL[dir] ? [{ swipe: { direction: SWIPE_FOR_SCROLL[dir] } }] : null;
    }
    case "swipe":
      return [{ swipe: { start: `${s.x1},${s.y1}`, end: `${s.x2},${s.y2}`, duration: s.ms ?? 250 } }];
    case "wait_for":
    case "wait_gone": {
      const sel = toSelector(s);
      if (!sel) return null;
      const wait: Record<string, unknown> = { [s.op === "wait_for" ? "visible" : "notVisible"]: sel };
      if (s.timeout !== undefined) wait.timeout = s.timeout;
      return [{ extendedWaitUntil: wait }];
    }
    case "wait_idle":
      return ["waitForAnimationToEnd"];
    case "screenshot":
      return [{ takeScreenshot: String(s.name ?? "screenshot") }];
    case "hide_keyboard":
      return ["hideKeyboard"];
    case "repeat": {
      const out: Record<string, unknown> = {};
      if (s.times !== undefined) out.times = s.times;
      if (s.while && typeof s.while === "object") {
        const w = s.while as Record<string, unknown>;
        const k = "notVisible" in w ? "notVisible" : "visible";
        const t = w[k];
        const sel = toSelector(t && typeof t === "object" ? (t as Record<string, unknown>) : { text: t });
        if (!sel) return null;
        out.while = { [k]: sel };
      }
      const cmds: Cmd[] = [];
      for (const raw of (s.steps as Record<string, unknown>[] | undefined) ?? []) {
        const inner = stepToMaestro(fromCompact(raw), appId);
        if (!inner) return null;
        cmds.push(...inner);
      }
      out.commands = cmds;
      return [{ repeat: out }];
    }
    case "run_flow": {
      const out: Record<string, unknown> = {};
      if (s.when && typeof s.when === "object") {
        const w = s.when as Record<string, unknown>;
        const k = "notVisible" in w ? "notVisible" : "visible";
        const t = w[k];
        const sel = toSelector(t && typeof t === "object" ? (t as Record<string, unknown>) : { text: t });
        if (!sel) return null;
        out.when = { [k]: sel };
      }
      if (typeof s.file === "string") out.file = s.file;
      if (s.vars && typeof s.vars === "object") out.env = s.vars;
      if (Array.isArray(s.steps)) {
        const cmds: Cmd[] = [];
        for (const raw of s.steps as Record<string, unknown>[]) {
          const inner = stepToMaestro(fromCompact(raw), appId);
          if (!inner) return null;
          cmds.push(...inner);
        }
        out.commands = cmds;
      }
      return [Object.keys(out).length === 1 && out.file ? { runFlow: out.file } : { runFlow: out }];
    }
    case "observe":
    case "apps":
    case "windows":
      return [];
  }
  return null;
}

/** A flow as a Maestro file. appId defaults to the first launched or stopped package. */
export function toMaestro(flow: FlowFile, appId?: string): Converted<string> {
  const steps = flow.steps.map(fromCompact);
  const app = appId ?? (steps.find((s) => s.op === "launch" || s.op === "stop_app" || s.op === "clear_app")?.package as string | undefined);
  if (!app) throw new Error("the flow launches no app, so Maestro's appId is unknown (pass --app-id)");
  const skipped: string[] = [];
  if (flow.dismiss?.length) skipped.push(`dismiss ${brief(flow.dismiss)} (Maestro has none; add optional taps where it shows up)`);
  const cmds: Cmd[] = [];
  steps.forEach((s, i) => {
    const out = stepToMaestro(s, app);
    if (out) cmds.push(...out);
    else skipped.push(`step ${i + 1}: ${brief(toCompact(s))}`);
  });
  const header = stringify({ appId: app, name: flow.name }, { lineWidth: 0 });
  return { out: `${header}---\n${stringify(cmds, { lineWidth: 0 })}`, skipped };
}

// Keys a Maestro selector may carry that change nothing here.
const IGNORED_KEYS = new Set(["label", "retryTapIfNoChange", "waitToSettleTimeoutMs"]);

/** Maestro selector -> droidreplay target, or a reason it has no counterpart. */
function fromSelector(v: unknown): Record<string, unknown> | string {
  if (typeof v === "string" || typeof v === "number") return { text: ourText(String(v)) };
  if (!v || typeof v !== "object") return "empty selector";
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === "text") out.text = ourText(String(x));
    else if (k === "id") out.id = String(x);
    else if (k === "index") out.index = Number(x);
    else if (k === "optional") out.optional = x === true;
    else if (k === "point") {
      const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(String(x));
      if (!m) return `point ${x} (only absolute x,y)`;
      out.x = Number(m[1]);
      out.y = Number(m[2]);
    } else if (RELATIVE_KEYS.includes(k)) {
      const a = fromSelector(x);
      if (typeof a === "string") return `${k}: ${a}`;
      const keys = Object.keys(a);
      out[k] = keys.length === 1 && keys[0] === "text" ? a.text : a;
    } else if (!IGNORED_KEYS.has(k)) return `selector key ${k}`;
  }
  return Object.keys(out).some((k) => k !== "optional") ? out : "empty selector";
}

function cmdToSteps(name: string, arg: unknown, appId: string | undefined): Step[] | string {
  const obj = arg && typeof arg === "object" ? (arg as Record<string, unknown>) : {};
  const sel = () => {
    const t = fromSelector(arg);
    if (typeof t === "string") throw new Error(t);
    return t;
  };
  const app = (v: unknown) => {
    const pkg = typeof v === "string" ? v : (obj.appId as string | undefined) ?? appId;
    if (!pkg) throw new Error("no appId");
    return pkg;
  };
  switch (name) {
    case "launchApp": {
      const extra = Object.keys(obj).filter((k) => k !== "appId" && k !== "clearState");
      if (extra.length) throw new Error(`launchApp ${extra.join(", ")}`);
      const pkg = app(arg);
      return [...(obj.clearState === true ? [{ op: "clear_app", package: pkg }] : []), { op: "launch", package: pkg }];
    }
    case "clearState":
      return [{ op: "clear_app", package: app(arg) }];
    case "stopApp":
      return [{ op: "stop_app", package: app(arg) }];
    case "tapOn":
      return [{ op: "tap", ...sel() }];
    case "longPressOn":
      return [{ op: "long_press", ...sel() }];
    case "inputText":
      return [{ op: "type", value: String(typeof arg === "object" && arg ? obj.text : arg), append: true }];
    case "eraseText":
      return [{ op: "type", value: "" }];
    case "back":
      return [{ op: "key", key: "back" }];
    case "pressKey": {
      const k = KEY_FROM_MAESTRO[String(arg).toLowerCase()];
      if (!k) throw new Error(`pressKey ${arg}`);
      return [{ op: "key", key: k }];
    }
    case "scroll":
      return [{ op: "scroll", dir: "down" }];
    case "swipe": {
      if (obj.direction) {
        const dir = SCROLL_FOR_SWIPE[String(obj.direction).toUpperCase()];
        if (!dir) throw new Error(`swipe direction ${obj.direction}`);
        return [{ op: "scroll", dir }];
      }
      const pt = (v: unknown) => /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(String(v));
      const a = pt(obj.start);
      const b = pt(obj.end);
      if (!a || !b) throw new Error("swipe (only absolute start/end)");
      const ms = obj.duration ?? 250;
      return [{ op: "swipe", x1: +a[1], y1: +a[2], x2: +b[1], y2: +b[2], ms }];
    }
    case "scrollUntilVisible": {
      const until = fromSelector(obj.element);
      if (typeof until === "string") throw new Error(until);
      const dir = String(obj.direction ?? "DOWN").toLowerCase();
      if (!SWIPE_FOR_SCROLL[dir]) throw new Error(`direction ${obj.direction}`);
      return [{ op: "scroll", dir, until }];
    }
    case "extendedWaitUntil": {
      const gone = "notVisible" in obj;
      const t = fromSelector(gone ? obj.notVisible : obj.visible);
      if (typeof t === "string") throw new Error(t);
      return [{ op: gone ? "wait_gone" : "wait_for", ...t, ...(obj.timeout !== undefined ? { timeout: Number(obj.timeout) } : {}) }];
    }
    case "assertVisible":
      return [{ op: "wait_for", ...sel() }];
    case "assertNotVisible":
      return [{ op: "wait_gone", ...sel() }];
    case "waitForAnimationToEnd":
      return [{ op: "wait_idle", ...(obj.timeout !== undefined ? { timeout: Number(obj.timeout) } : {}) }];
    case "takeScreenshot":
      return [{ op: "screenshot", name: String(typeof arg === "object" && arg ? obj.path : arg ?? "screenshot") }];
    case "hideKeyboard":
      return [{ op: "hide_keyboard" }];
    case "repeat": {
      const step: Step = { op: "repeat" };
      if (obj.times !== undefined) step.times = Number(obj.times);
      if (obj.while !== undefined) {
        const w = (obj.while ?? {}) as Record<string, unknown>;
        const keys = Object.keys(w);
        if (keys.length !== 1 || (keys[0] !== "visible" && keys[0] !== "notVisible")) throw new Error(`repeat while ${keys.join(", ")}`);
        const t = fromSelector(w[keys[0]]);
        if (typeof t === "string") throw new Error(t);
        const tk = Object.keys(t);
        step.while = { [keys[0]]: tk.length === 1 && tk[0] === "text" ? t.text : t };
      }
      if (step.times === undefined && step.while === undefined) throw new Error("repeat needs times or while");
      step.steps = convertCommands((obj.commands as Cmd[] | undefined) ?? [], appId).map(toCompact);
      return [step];
    }
    case "runFlow": {
      if (typeof arg === "string") return [{ op: "run_flow", file: arg }];
      const step: Step = { op: "run_flow" };
      if (obj.when !== undefined) {
        const w = (obj.when ?? {}) as Record<string, unknown>;
        const keys = Object.keys(w);
        if (keys.length !== 1 || (keys[0] !== "visible" && keys[0] !== "notVisible")) throw new Error(`runFlow when ${keys.join(", ")}`);
        const t = fromSelector(w[keys[0]]);
        if (typeof t === "string") throw new Error(t);
        const tk = Object.keys(t);
        step.when = { [keys[0]]: tk.length === 1 && tk[0] === "text" ? t.text : t };
      }
      if (obj.file !== undefined) step.file = String(obj.file);
      if (obj.env && typeof obj.env === "object") {
        step.vars = Object.fromEntries(Object.entries(obj.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      }
      if (Array.isArray(obj.commands)) step.steps = convertCommands(obj.commands as Cmd[], appId).map(toCompact);
      if (step.file === undefined && step.steps === undefined) throw new Error("runFlow needs file or commands");
      return [step];
    }
  }
  return name;
}

/** Nested commands (runFlow's `commands`): all of them convert or the block is skipped as a whole. */
function convertCommands(cmds: Cmd[], appId: string | undefined): Step[] {
  const steps: Step[] = [];
  cmds.forEach((c, i) => {
    const [cmd, arg] = typeof c === "string" ? [c, undefined] : (Object.entries(c)[0] ?? ["?", undefined]);
    let out: Step[] | string;
    try {
      out = cmdToSteps(cmd, arg, appId);
    } catch (e) {
      out = (e as Error).message;
    }
    if (typeof out === "string") throw new Error(`commands ${i + 1}: ${out}`);
    steps.push(...out);
  });
  return mergeErase(steps);
}

/** A Maestro file as a flow. `name` wins over the header's name. */
export function fromMaestro(text: string, name?: string): Converted<FlowFile> {
  const docs = parseAllDocuments(text).map((d) => d.toJS());
  const cmdsDoc = [...docs].reverse().find((d) => Array.isArray(d));
  if (!cmdsDoc) throw new Error("no command list (expected a header, ---, then a list)");
  const header = (docs.find((d) => d && typeof d === "object" && !Array.isArray(d)) ?? {}) as Record<string, unknown>;
  const appId = header.appId as string | undefined;
  const skipped: string[] = [];
  const steps: Step[] = [];
  (cmdsDoc as Cmd[]).forEach((c, i) => {
    const [cmd, arg] = typeof c === "string" ? [c, undefined] : Object.entries(c)[0] ?? ["?", undefined];
    try {
      const out = cmdToSteps(cmd, arg, appId);
      if (typeof out === "string") throw new Error(out);
      steps.push(...out);
    } catch (e) {
      skipped.push(`command ${i + 1}: ${brief(c)} (${(e as Error).message})`);
    }
  });
  return { out: { name: name ?? String(header.name ?? "maestro"), steps: mergeErase(steps).map(toCompact) }, skipped };
}

/** eraseText then inputText is one replacing type here. */
function mergeErase(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    if (s.op === "type" && s.append === true && prev?.op === "type" && prev.value === "" && Object.keys(prev).length === 2) {
      const { append: _append, ...rest } = s;
      out[out.length - 1] = rest as Step;
    } else {
      out.push(s);
    }
  }
  return out;
}
