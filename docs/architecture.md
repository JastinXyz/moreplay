# Architecture

```
MCP client (Claude Code, ...)
   │ stdio (MCP)
   ▼
moreplay server (Node, src/)            laptop
   │ adb push / adb shell app_process / adb forward tcp:N -> tcp:9070
   ▼
agent (Java jar in /data/local/tmp)        device, runs as the shell user
   │ UiAutomation (reflection) + accessibility tree + injectInputEvent
   ▼
apps on screen
```

## What the model is told

The tool definitions stay under a 3700-char budget because they are re-sent with every
request. Longer guidance goes elsewhere:

- MCP `instructions` (`src/help.ts`), sent once when a client connects: the observe -> act loop,
  batching, record/save/replay, secrets as vars, and where the full reference is.
- `flow {action: "help", name: steps | selectors | flows | cli}` returns
  `docs/reference/<topic>.md`, which ships in the npm package. With no name it lists the topics.
  The model reads a topic when it needs it (for example before writing position selectors by
  hand) instead of paying for it on every request.

## Agent lifecycle

1. First tool call runs `Device.ensureAgent()`: pick the device (`ANDROID_SERIAL` or the only
   one connected), kill a leftover agent, push the jar only if its md5 differs from the copy on
   the device, `adb forward tcp:0 tcp:9070`, spawn
   `adb shell CLASSPATH=/data/local/tmp/moreplay.jar app_process / dev.moreplay.agent.Main 9070`.
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

## Crashes

When a step fails, `executeSteps` reads the crash buffer since the batch began (`logcat -b crash -T`)
and, if the app died, appends `app crashed:` with the FATAL EXCEPTION header, the exception and
its top four frames to that step's error. Only on failure (a passing batch costs nothing extra)
and only at the top level (a subflow's failure is not reported twice). `moreplay run` prints
the crash under the failed step once the flow stops, since step lines stream before it is known.

## Timeouts

Nothing waits forever. adb calls get 30 s (pushing the jar 2 min, `doctor`'s checks 10 s) and
fail naming the command. A `/run` request gets 30 s plus what its steps ask for (`stepBudget`:
`wait`, `timeout` with wait_for/wait_gone/wait_idle defaulting to 5 s, sleep and long_press `ms`,
1.5 s per scroll swipe); past that the agent is killed and the next call starts a fresh one.
Screenshots and crops get 20 s.

## Agent HTTP protocol

Bound to 127.0.0.1 on the device; reached only through `adb forward`.

- `GET /ping` -> `pong <version>` (version baked in at build time)
- `POST /run` body `{"steps":[...], "stopOnError":true}` ->
  `{"ok":bool, "ms":n, "results":[{"op","ok","ms","out"|"error","sel"?}]}`. `sel` is the stable
  selector of the element a targeted step acted on (see Flows). With `"stream":true` the
  response is NDJSON instead: one result object per step, written as the step finishes, then
  `{"done":true, "ok", "ms"}` (or `{"done":true, "ok":false, "error"}` if the run itself
  threw). Still one request, so no extra round trips; `moreplay run` uses it to print each
  step live (`Device.run(steps, stop, onResult)` -> `executeSteps(..., onStep)` ->
  `runFlow({onStep})`). The MCP tools return one response, so they don't stream.
- `GET /screenshot?max=<longest side, 0 = full>&q=<jpeg quality>` -> `image/jpeg`

## Steps

Each step is `{"op": "...", ...}`. Targets for tap/long_press/type/wait_*:
`ref` (from the latest observe) | `x`,`y` | `text` (text or content-desc, exact first, then
contains, case-insensitive) | `id` (full or the part after `:id/`) | `desc`. When the matched node
is not clickable, the agent taps its nearest clickable ancestor. A selector tap reports what it
hit: `tapped 540,886 "Order 1000" (partial match for "1")`; the partial note shows when plain
text only matched inside a longer label, never for a regex (the recorder still reads the
coordinates first). Before tapping, a selector tap (1) closes the keyboard when it is up and
the target is not a field, then finds the target again: React Native spends a tap made while
the keyboard is up on closing it, so a search result needed two taps; (2) waits until the
target's bounds stay the same for 60 ms (refreshing that one node, at most 1.5 s), so a target
still moving (a list closing above it, a calendar sliding up as the keyboard hides) is not
tapped where it was. That costs roughly 100-200 ms per tap.

`type {field}` finds the field by, best first: an editable whose hint matches exactly (filled
or not; a filled field's text is its value), one whose text matches exactly, the nearest
editable below an exact label (`Location *` above the field), then contains matches of hint and
text. It taps the field's center to focus it. Optional `wait` (ms) polls a
text/id/desc target until it appears, is not covered (a splash screen or a sheet still on top) and is enabled (a submit button the app enables once it has handled the input; one still disabled at the timeout is tapped anyway, as in Maestro, and an explicit `enabled` selector is not waited on); replays set it on every targeted step. A coordinate tap has no element to wait for, so replays give it `settle` (3 s) instead: it waits until the screen stops changing (300 ms quiet), since a tap while a page still slides in lands on nothing. When the cover is another app's window, the error names it (`is behind a dialog from <package> ("...")`).

Text (and desc) written `"/like this/"` is a regex, case-insensitive, compiled once per
pattern: the whole text matching counts as exact, a match inside it as contains. Plain text is
never a regex, so labels such as `Search...` mean what they say.

Position keys `below` / `above` / `leftOf` / `rightOf` (Maestro's names) take another target
(`"text"` or `{text|id|desc}`, which may nest its own position keys). Among the matches, or the
tappable elements when the step has no text/id/desc (icons without a label), the agent keeps
those whose center lies past that edge of every anchor, drops any that contain an anchor or sit
inside one, and picks the nearest (sum of center distances); an exact text match still beats a
contains match. A missing anchor counts as not found, so `wait` keeps polling for it. Keypads
are the typical case: `tap: {text: "1", below: "Enter your PIN"}`.

`index: n` (0-based) picks the n-th match: in reading order (top to bottom, then left to right;
exact matches if any, else contains), or with position keys in nearest-first order.

States `enabled` / `checked` / `selected` / `focused: true|false` filter a match. `childOf: target`
keeps elements inside a match of that target; `containsChild: target` keeps elements with a
descendant that matches it (both targets need text, id or desc). With only childOf /
containsChild and no text/id/desc, the target is the smallest tappable element that satisfies
them, since every outer container contains the child too.

`x`, `y` (tap, long_press, type) and `x1`..`y2` (swipe) take pixels or `"50%"` of the screen,
measured as the union of every window the system lists.

| op | params | where |
|---|---|---|
| observe | | agent |
| tap / long_press | target, `ms` for long_press | agent |
| type | `value`, optional target or `field` (label text), `submit`, `append` (ignored while the field shows its hint) | agent (ACTION_SET_TEXT) |
| scroll | `dir`, optional `until` (target, or plain text / `/regex/`; fails when not found by the end), `max` | agent (scroll action, swipe fallback) |
| swipe | `x1,y1,x2,y2,ms` | agent |
| key | back, home, enter, recents, delete, tab, or a keycode | agent |
| wait_for / wait_gone | target, `timeout` | agent (polls every 40 ms). wait_gone on a target that was never on screen passes with `not on screen (nothing to wait for)`, so a selector typo shows |
| wait_idle | `quietMs`, `timeout` | agent (tree unchanged for quietMs) |
| sleep | `ms` | agent |
| hide_keyboard | | agent (back while the input-method window is listed, until it has stayed hidden for 400 ms, so a keyboard still sliding in after a tap on a field is caught too; at most one back per second, fails after 3 s) |
| windows | | agent (debug: every window the system reports, with type/layer/title) |
| launch / stop_app / clear_app | `package` (validated as a package name before it reaches `adb shell`) | server (`cmd package resolve-activity` + `am start -W`, which returns once the activity is drawn so the next step cannot read the app that was in front before; `am force-stop`, `pm clear`; clear_app fails unless pm answers `Success`, then waits 1.5 s and up to 3 s more for Android's asynchronous runtime-permission reset, which otherwise revokes a grant made right after) |
| apps | `filter` | server (`pm list packages -3`) |
| launch `args` | `{name: value}` intent extras: booleans `--ez`, integers `--ei`, other numbers `--ef`, the rest `--es` (single-quoted; names `[\w.-]+`) | server |
| install_app / uninstall_app | `path` (relative to the working directory), `grant` (`-g`, every runtime permission) / `package` | server (`adb install -r`, 5 min limit; `pm uninstall`); both fail unless the answer is `Success` |
| logs | `package`, `level` (V D I W E F, default W), `since` (`30s`, `2m`, `1h`; default 60s), `lines` (default 50, max 500) | server (`logcat -d -v brief -T <since>`, `--pid` while the app runs, else its crash buffer). Long lines are cut at 240 chars and repeats folded into `(xN)` to keep tokens down |
| open_link | `url` (one line, single-quoted), optional `package` | server (`am start -W -a VIEW -d`; an `Error:` line fails the step) |
| permissions | `package`, `grant` (names or `"all"`), `revoke`; `CAMERA` means `android.permission.CAMERA` | server (`pm grant/revoke`; `all` = the app's requested permissions from `dumpsys package`, skipping the ones pm refuses) |
| screenshot | `name`: a file name (saved in `.moreplay/evidence`, made safe) or a path (absolute or with a slash, used as given; `.jpg` added) | server |

The `act` tool (`src/act.ts`) splits a batch into runs of agent ops and server ops, executes them in order,
stops at the first failure, then (unless `observe_after: false`) waits for idle and appends the
screen. Every tap/long_press/type after the first that targets `text`, `id`, `desc` or `field`
gets `wait: 3000`, because a step that opens a sheet returns before the sheet's content is in
the tree. The first one gets `wait: 1000`: right after the agent restarts (a `moreplay run` took
the device meanwhile) the tree can be empty for a moment. `ref` and `x,y` targets do not wait, and recording keeps the steps as given.

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
covers only with its content, and one with no content and no image (React Native lists a
background shape drawn behind with `zIndex` after the header it sits under) covers nothing.
Position selectors (`below`, `above`, ...) skip candidates that are covered, so a node hidden
behind a bottom sheet cannot win as the nearest. A node hidden entirely (with its subtree) is not listed, and the
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

A flow is a YAML file in `.moreplay/flows` (relative to where the server or CLI runs), or
anywhere else; there is no config for these folders. Every `flow` action and `moreplay run`
take a name (looked up in that folder, made safe so it cannot leave it) or a path (has a slash
or ends in `.yaml`, used as given). `record{name}` with a path saves there; `patch` writes back
to the file it loaded. Evidence defaults to `.moreplay/evidence`; `run{evidence}` (CLI:
`--evidence`) sets the folder for one run, and `moreplay import --out` picks the output
file, so a model can keep files in its own scratch space:

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
  the tapped coordinates. For `type`, a label selector is stored as `field`. Steps inside
  `repeat` / `run_flow` are compacted the same way (`toCompact` recurses into `steps`), and
  screenshots taken by `act` while recording go to `$TMPDIR/moreplay-recording` rather than
  the client's working directory (it is a rehearsal; the replay saves the real evidence).
- **Secrets while recording**: `flow record{name, vars}` keeps the vars for the session. `act`
  fills `${var}` from them before the steps reach the device (a `${var}` with no value fails
  before anything runs), and the recorder writes every occurrence of a value (3+ chars,
  longest first) back as `${var}` (`hideVars`), also when the model typed the value itself.
  So a recorded login never holds the PIN; replay takes it from `vars` / `--var`.
- **Suites** (`moreplay run` only): several targets, and a folder stands for the `.yaml` files
  directly in it, sorted by name (subfolders hold subflows). A flow's `tags: [...]` meet
  `--include-tags` (any of them) and `--exclude-tags` (none of them). Flows run one after
  another on one agent; a flow that cannot start (a missing `${var}`) fails and the rest still
  run. With more than one flow, or any skipped by tags, a summary closes the run (`PASS  3
  flows: 2 passed, 1 skipped by tags`, failed flows listed). Exit 1 if any failed or none
  matched. `--junit <file>` writes JUnit XML: a testcase per flow (classname = file, name = flow
  name), `<failure message="step N: ...">` with the error, the crash and the artifact paths,
  `<skipped>` for flows left out by tags.
- **Failure artifacts**: when a step fails, `runFlow` saves `failed-step-N.jpg` and
  `failed-step-N.txt` (the observe output) in the run's evidence folder and lists them in its
  text and `FlowRun.artifacts`; a device that is gone just skips them. Maestro header `tags` map to flow `tags` both ways.
- **Replay** (`flow run`, or `moreplay run` with no model): `${var}` substitution (missing
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
- **Expressions**: `${...}` takes `NAME`, `NAME[n]` (one character, e.g. a PIN digit), `!!NAME`
  (set and not empty) and `NAME == 'x'` / `NAME != 'x'`. Anything else fails before the flow
  runs rather than being half-understood. A plain `NAME` must be set and not empty (an empty
  value is nearly always an env var that was never filled, passed as `--var X=`; typing it
  would pass and fail later somewhere unrelated). In the other forms a missing or empty var
  counts as empty, so `${!!NAME}` is how a flow tests for an optional one. Maestro's `${...}` is JavaScript, so import keeps these forms and
  anything richer fails at replay with a clear message.
- **Subflows and conditions** (`run_flow`, a host op, so it splits the batch): `{file}` loads
  another flow file relative to the calling flow's folder (`.yaml` optional), `{steps}` runs an
  inline list; `vars` are layered on the caller's (a subflow's own `${var}`s are filled when it
  runs, not up front). `when: {visible | notVisible: target}` is checked once on the current
  screen (a `wait_for` / `wait_gone` with `timeout: 0`), or `when: {true: "${!!CARD}"}` decided by the
  vars alone; not met reports `skipped (when not
  met)` and passes. Inner steps get the same waits and `dismiss` list as the flow. A failure
  names the inner step (`step 2 (tap) failed: ...`); nesting stops at 8 levels so a flow that
  runs itself fails instead of looping. `act` takes run_flow too, with files relative to the
  server's working directory.
- **Loops** (`repeat`, a host op): `steps` run up to `times`, while `while: {visible | notVisible:
  target}` holds (checked before each round, like run_flow's `when`). `while` alone stops after
  100 rounds with an error rather than looping forever. A failure names the round and step.
  The step's output is `ran N times`, and `moreplay run` prints `ran Nx` on its line (yellow for
  0): a `while` checked before a debounced search result appeared ran 0 rounds unnoticed.
- **Self-heal**: on failure the tool returns the 1-based step number, the step, the screen, and
  a `flow patch` hint. `patch{name, index, steps}` replaces that step (`steps: []` deletes).

## Maestro export/import (src/maestro.ts)

`moreplay export <flow> [--app-id pkg] [--out file]` and `moreplay import <file>
[--name n]`. CLI only, so the MCP tool budget stays the same. Steps with no counterpart are
left out and listed on stderr (`skipped`), never dropped silently. `${var}` passes through both
ways (Maestro reads it from `-e var=...`).

| moreplay | Maestro |
|---|---|
| launch / stop_app / clear_app | `launchApp` / `stopApp` / `clearState` (bare when the package is the header's `appId`, which defaults to the first launched package). Import turns `launchApp: {clearState: true}` into clear_app + launch |
| text everywhere | Maestro reads text as a regex: import wraps text using regex characters other than `.` in `/.../`; export writes `/re/` as `re` and escapes plain text. `${var}` is left alone both ways |
| tap / long_press `text`, `desc`, `id`, `x,y`, position keys | `tapOn` / `longPressOn` with `text` (Maestro's text also matches content-desc), `id`, `point: "x,y"`, `below`/`above`/`leftOf`/`rightOf` (same names, anchors converted the same way); `optional` kept |
| type `{field, value}` | `tapOn: field`, `eraseText` (unless `append`), `inputText`, `pressKey: Enter` for `submit`. Import folds `eraseText` + `inputText` back into one replacing type |
| key back / home / enter / delete / tab | `back`, `pressKey: Home/Enter/Backspace/Tab` |
| scroll `dir` | `scroll` for down; `swipe: {direction}` names the finger's direction, so up -> DOWN, right -> LEFT |
| scroll `until` | `scrollUntilVisible: {element, direction}` |
| swipe x1..y2 | `swipe: {start, end, duration}` (absolute points only on import) |
| wait_for / wait_gone | `extendedWaitUntil: {visible / notVisible, timeout}`; import also maps `assertVisible` / `assertNotVisible` |
| wait_idle, screenshot | `waitForAnimationToEnd`, `takeScreenshot` |
| repeat, hide_keyboard, `index` | `repeat: {times, while: {visible / notVisible}, commands}`, `hideKeyboard`, selector `index` (0-based on both sides) |
| launch args, open_link, permissions | `launchApp` without `permissions` imports as `permissions {grant: all}` + launch, because Maestro grants everything on launchApp by default (`Orchestra.kt`: "default to allow all on app launch"); export folds that pair back into a plain `launchApp`. `launchApp: {arguments, permissions}`, `openLink` (url or `{link}`), `setPermissions`, `killApp` -> stop_app. Maestro permission names (`camera`, `location`, `notifications`, ...) map to Android's; export writes the Android names. install/uninstall have no Maestro command and are listed as skipped |
| run_flow | `runFlow` (a bare file, or `file` / `env` / `commands` / `when: {visible / notVisible}`); `when: {true: "${...}"}` keeps its expression, and a `commands` block converts whole or not at all |

Not mapped: refs, `sleep`, keycodes and recents, the `dismiss` list (export); relative
selector keys `width` / `height` / `tolerance`, `traits`, `containsDescendants`, other `launchApp` options (`stopApp: false`, ...),
scripts, `when: {platform}` (import). observe/apps/windows export to nothing.
Maestro matches `text` as a regex, moreplay as exact-then-contains, so a label with regex
characters may match differently after a conversion.
