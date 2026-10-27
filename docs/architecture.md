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
screen. Every tap/long_press/type after the first that targets `text`, `id`, `desc` or `field`
gets `wait: 3000`, because a step that opens a sheet returns before the sheet's content is in
the tree. `ref` and `x,y` targets do not wait, and recording keeps the steps as given.

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
editable/scrollable. Flags: tap, edit, scroll, on/off (checkable), selected, disabled,
icon (pressable, no label, an image or SVG inside). Editable fields add `hint="..."`; an empty
field reports its hint as its text, so it shows only the hint (`EditText hint="Cari.."`).

Icon crops: `screenshot {refs: [0, 6, 7]}` returns one small JPEG with those refs' visible
bounds side by side (each fit into 96x96, left to right in the order asked), so a model can
see what unlabeled icons are for ~40 tokens instead of a full screenshot. Nothing is saved.
Agent endpoint: `GET /crops?refs=0,6,7&size=96&q=80`.

Node cache: UiAutomation keeps a node cache in the agent process, and it is why reads are
fast (a cold read of the launcher takes ~500 ms, a cached one ~40). Chromium does not always
send a content-changed event (an ad's "Lanjut ke aplikasi" fading in stayed invisible to the
agent for good), so the cache is cleared only where staleness matters and the cost hides:
at most once a second while a step polls, and before an observe that follows a screen with
a WebView. `type` waits up to 2 s for input focus after its tap, then focuses the matched
editable node itself (web fields sometimes never report focus).

WebView: Chromium exposes the page through accessibility, so web content shows up in observe
like native views (`View "OPEN BRAVE SEARCH" tap`, `EditText #searchbox` from the HTML id);
tap, type, scroll and wait_for work on it unchanged. Tested on an Android WebView app.

Tap points: `[x,y]` of a tap target is the center of its visible part, not of its bounds. Later
siblings of the node or of its ancestors (a bottom tab bar, a floating tab bar, a sheet) are cut
away when they span at least 90% of its width or height; a later sibling that fills its parent
covers only with its content. A node hidden entirely (with its subtree) is not listed, and the
output ends with `(elements hidden under bars or overlays not listed)`; a bottom sheet over the
home screen went from 44 lines to 7. A selector tap on a hidden node fails with "covered by
another element (scroll it into view)". Found on a card under a floating
tab bar, where the bounds center hit the Scan QR button.

Windows: observe and selectors cover every app-type window the system reports (activities,
dialogs, popups, permission prompts) plus the active window, top-most first. With more than
one window each gets a `-- <title>` header; with one, its title is on the first line
(`window="Jendela Pop-up"`). Status/navigation bars are skipped. The keyboard is not listed,
only flagged as `keyboard=shown` (`type` sets text directly). While a modal popup is open the
system reports only the popup, so the activity behind it does not appear.

Covered screens: JS navigators (React Navigation, Flutter) keep earlier screens mounted as
full-size siblings under the current one, and accessibility reports them as visible. When a
later sibling fills its parent and its content (text, descriptions, controls) spans at least
half the parent's height, each earlier sibling whose content lies at least half under that
content is skipped by observe and by selectors. A full-size layer holding only a small button
does not count, and a sibling beside the cover's content stays (an interstitial ad fills the
WebView but its content starts below the "Lanjut ke aplikasi" header). Found on a PIN screen
over a home screen: observe went from 52 lines to 15, and `tap: Beranda` no longer hits the
hidden screen.

Scroll: picks the biggest scrollable node offering the directional action
(ACTION_SCROLL_DOWN/UP/LEFT/RIGHT) in the top-most window that has one, else the biggest
scrollable; performs the action, or swipes inside that node when the action is refused (the
finger moves against `dir`: down swipes up, left swipes right). It
then waits up to 700 ms for the tree to change (actions are async); no change means the end
of the list.

## Flows (src/flow.ts)

A flow is a YAML file in `DROIDREPLAY_FLOWS_DIR` (default `./flows`):

```yaml
name: my-device
dismiss: [Lanjut ke aplikasi, {id: close}]   # optional: tapped away whenever they appear
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
- **Popups that come and go**: a step with `optional: true` is skipped (`skipped (not
  found: ...)`, still ok) when its element does not show up within its wait. For things that
  appear at unpredictable times (interstitial ads, permission prompts), the top-level
  `dismiss` list goes to every targeted and wait_for step; while such a step polls, the agent
  taps the first dismiss selector on screen, resets the step's wait, and notes
  `(dismissed text="...")` in its output. Found on a WebView app whose ad appears seconds after
  launch and shows "Lanjut ke aplikasi" only after a countdown.
- **Self-heal**: on failure the tool returns the 1-based step number, the step, the screen, and
  a `flow patch` hint. `patch{name, index, steps}` replaces that step (`steps: []` deletes).

## Maestro export/import (src/maestro.ts)

`droidreplay export <flow> [--app-id pkg] [--out file]` and `droidreplay import <file>
[--name n]`. CLI only, so the MCP tool budget stays the same. Steps with no counterpart are
left out and listed on stderr (`skipped`), never dropped silently. `${var}` passes through both
ways (Maestro reads it from `-e var=...`).

| droidreplay | Maestro |
|---|---|
| launch / stop_app | `launchApp` / `stopApp` (bare when the package is the header's `appId`, which defaults to the first launched package) |
| tap / long_press `text`, `desc`, `id`, `x,y` | `tapOn` / `longPressOn` with `text` (Maestro's text also matches content-desc), `id`, `point: "x,y"`; `optional` kept |
| type `{field, value}` | `tapOn: field`, `eraseText` (unless `append`), `inputText`, `pressKey: Enter` for `submit`. Import folds `eraseText` + `inputText` back into one replacing type |
| key back / home / enter / delete / tab | `back`, `pressKey: Home/Enter/Backspace/Tab` |
| scroll `dir` | `scroll` for down; `swipe: {direction}` names the finger's direction, so up -> DOWN, right -> LEFT |
| scroll `until` | `scrollUntilVisible: {element, direction}` |
| swipe x1..y2 | `swipe: {start, end, duration}` (absolute points only on import) |
| wait_for / wait_gone | `extendedWaitUntil: {visible / notVisible, timeout}`; import also maps `assertVisible` / `assertNotVisible` |
| wait_idle, screenshot | `waitForAnimationToEnd`, `takeScreenshot` |

Not mapped: refs, `sleep`, keycodes and recents, the `dismiss` list (export); relative
selectors (`below`, `index`, ...), percent points, `launchApp` options like `clearState`,
`runFlow`, `repeat`, scripts, `hideKeyboard` (import). observe/apps/windows export to nothing.
Maestro matches `text` as a regex, droidreplay as exact-then-contains, so a label with regex
characters may match differently after a conversion.
