# Architecture

```
MCP client (Claude Code, ...)
   │ stdio (MCP)
   ▼
droidreplay server (Node, src/)            laptop
   │ adb push / adb shell app_process / adb forward tcp:N -> tcp:9070
   ▼
agent (Java jar in /data/local/tmp)        device, runs as the shell user
   │ UiAutomation (reflection) + accessibility tree + injectInputEvent
   ▼
apps on screen
```

## Agent lifecycle

1. First tool call runs `Device.ensureAgent()`: pick the device (`ANDROID_SERIAL` or the only
   one connected), kill a leftover agent, push the jar only if its md5 differs from the copy on
   the device, `adb forward tcp:0 tcp:9070`, spawn
   `adb shell CLASSPATH=/data/local/tmp/droidreplay.jar app_process / dev.droidreplay.agent.Main 9070`.
2. Wait for `GET /ping` to answer `pong <version>` with the server's own `package.json`
   version (up to 8 s). A different version is reported as a stale agent. If the agent log
   mentions an existing UiAutomation registration, report that another tool holds the slot.
3. On server exit (stdin closed, SIGINT/SIGTERM): kill the adb shell child (the device process
   dies with it) and remove the forward.

## UiAutomation bootstrap (agent/Main.java)

`new UiAutomationConnection()` and `new UiAutomation(Looper, connection)` by reflection, then
`connectWithTimeout(FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES, 5000)` (falls back to
`connect(int)`). `FLAG_RETRIEVE_INTERACTIVE_WINDOWS` is added to the service info. Pattern taken
from AOSP `cmds/uiautomator` and openatx/android-uiautomator-server-jar.

## Agent HTTP protocol

Bound to 127.0.0.1 on the device; reached only through `adb forward`.

- `GET /ping` -> `pong <version>` (version baked in at build time)
- `POST /run` body `{"steps":[...], "stopOnError":true}` ->
  `{"ok":bool, "ms":n, "results":[{"op","ok","ms","out"|"error","sel"?}]}`. `sel` is the stable
  selector of the element a targeted step acted on (see Flows).
- `GET /screenshot?max=<longest side, 0 = full>&q=<jpeg quality>` -> `image/jpeg`

## Steps

Each step is `{"op": "...", ...}`. Targets for tap/long_press/type/wait_*:
`ref` (from the latest observe) | `x`,`y` | `text` (text or content-desc, exact first, then
contains, case-insensitive) | `id` (full or the part after `:id/`) | `desc`. When the matched node
is not clickable, the agent taps its nearest clickable ancestor. Optional `wait` (ms) polls a
text/id/desc target until it appears; replays set it on every targeted step.

| op | params | where |
|---|---|---|
| observe | | agent |
| tap / long_press | target, `ms` for long_press | agent |
| type | `value`, optional target or `field` (label text), `submit`, `append` | agent (ACTION_SET_TEXT) |
| scroll | `dir`, optional `until` {target}, `max` | agent (scroll action, swipe fallback) |
| swipe | `x1,y1,x2,y2,ms` | agent |
| key | back, home, enter, recents, delete, tab, or a keycode | agent |
| wait_for / wait_gone | target, `timeout` | agent (polls every 40 ms) |
| wait_idle | `quietMs`, `timeout` | agent (tree unchanged for quietMs) |
| sleep | `ms` | agent |
| windows | | agent (debug: every window the system reports, with type/layer/title) |
| launch / stop_app | `package` (validated as a package name before it reaches `adb shell`) | server (`cmd package resolve-activity`, `am start`) |
| apps | `filter` | server (`pm list packages -3`) |
| screenshot | `name` | server (saves to `DROIDREPLAY_EVIDENCE_DIR`) |

The `act` tool (`src/act.ts`) splits a batch into runs of agent ops and server ops, executes them in order,
stops at the first failure, then (unless `observe_after: false`) waits for idle and appends the
screen.

## Observe format

```
app=com.miui.calculator window="Kalkulator" keyboard=shown
@26 TextView "7" #digit_7 [350,1655] tap
@8 EditText "27.900.000÷24" #expression [540,790] tap edit
```

`@ref Class "label" #id [centerX,centerY] flags`. Text and content-desc of a pressable node's
non-pressable descendants are folded into its label (deduplicated, max 100 chars; a part
already contained in a longer one is dropped, since a content-desc often repeats its
children's text), and those
descendants get no line of their own. Non-pressable nodes appear only if they carry text or are
editable/scrollable. Flags: tap, edit, scroll, on/off (checkable), selected, disabled.

Windows: observe and selectors cover every app-type window the system reports (activities,
dialogs, popups, permission prompts) plus the active window, top-most first. With more than
one window each gets a `-- <title>` header; with one, its title is on the first line
(`window="Jendela Pop-up"`). Status/navigation bars are skipped. The keyboard is not listed,
only flagged as `keyboard=shown` (`type` sets text directly). While a modal popup is open the
system reports only the popup, so the activity behind it does not appear.

Covered screens: JS navigators (React Navigation, Flutter) keep earlier screens mounted as
full-size siblings under the current one, and accessibility reports them as visible. When a
later sibling fills its parent and its content (text, descriptions, controls) spans at least
half the parent's height, the siblings before it are skipped by observe and by selectors. A
full-size layer holding only a small button does not count. Found on a PIN screen over a home
screen: observe went from 52 lines to 15, and `tap: Beranda` no longer hits the hidden screen.

Scroll: picks the biggest scrollable node offering the directional action
(ACTION_SCROLL_DOWN/UP/LEFT/RIGHT) in the top-most window that has one, else the biggest
scrollable; performs the action, or swipes inside that node when the action is refused. It
then waits up to 700 ms for the tree to change (actions are async); no change means the end
of the list.

## Flows (src/flow.ts)

A flow is a YAML file in `DROIDREPLAY_FLOWS_DIR` (default `./flows`):

```yaml
name: my-device
steps:
  - launch: com.android.settings
  - tap: Perangkat saya          # short form = {text: ...}
  - type: {field: Email, value: "${email}"}
  - screenshot: my-device
  - key: back
  - wait_for: Perangkat saya
```

Short forms: launch/stop_app -> package, key -> key, screenshot -> name, sleep -> ms,
scroll -> dir, tap/long_press/wait_for/wait_gone -> text, type -> value, apps -> filter.

- **Recording** (`flow record` ... `flow save`): every successful `act` step goes to the
  recorder. observe, apps and wait_idle are dropped; `wait` is stripped. A `ref` becomes the
  agent's `sel`: unique id, else unique label, else id + own text, else label; with neither,
  the tapped coordinates. For `type`, a label selector is stored as `field`.
- **Replay** (`flow run`, or `droidreplay run` with no model): `${var}` substitution (missing
  vars fail before anything runs), `wait: 5000` on targeted steps and `timeout: 5000` on
  wait_for/wait_gone, then one `executeSteps`. Screenshot steps first wait for the screen to
  settle (tree unchanged 400 ms). Evidence goes to `<evidence>/<flow>/<YYYYMMDD-HHMMSS>/`.
- **Self-heal**: on failure the tool returns the 1-based step number, the step, the screen, and
  a `flow patch` hint. `patch{name, index, steps}` replaces that step (`steps: []` deletes).
