# Steps

Every step `act` and flow files accept. In `act` a step is `{op: "tap", text: "OK"}`; in a flow
file it is `- tap: {text: OK}`, and most steps have a short form (`- tap: OK`). Targets are
explained in the selectors topic.

## Touch and text

| Step | Parameters | Short form |
|---|---|---|
| `tap` | target | `tap: Sign in` |
| `long_press` | target, `ms` (default 700) | `long_press: Photo` |
| `type` | `value`; where: a target, or `field` (the field's label), or nothing for the focused field; `submit: true` presses enter after; `append: true` keeps the current text | `type: hello` |
| `swipe` | `x1`, `y1`, `x2`, `y2` (pixels or `"50%"`), `ms` (default 250) | |
| `scroll` | `dir`: down, up, left, right; `until`: a target to scroll to (fails if the end comes first); `max` swipes (default 10) | `scroll: down` |
| `key` | back, home, enter, recents, delete, tab, or an Android keycode | `key: back` |
| `hide_keyboard` | | |

## Waiting and checking

| Step | Parameters | Short form |
|---|---|---|
| `wait_for` | target, `timeout` ms (default 5000) | `wait_for: Home` |
| `wait_gone` | target, `timeout` | `wait_gone: Loading` |
| `wait_idle` | `quietMs` (default 300), `timeout` | |
| `sleep` | `ms` | `sleep: 500` |
| `observe` | | |
| `screenshot` | `name`: a file name (saved under the evidence folder) or a path | `screenshot: home` |

## Apps

| Step | Parameters | Short form |
|---|---|---|
| `launch` | `package`, `args` (intent extras: `{user: "a", count: 3, debug: true}`) | `launch: com.app` |
| `stop_app` | `package` | `stop_app: com.app` |
| `clear_app` | `package`. Wipes data, cache and runtime permissions, like a fresh install | |
| `install_app` | `path` to an .apk, `grant: true` to grant every permission | |
| `uninstall_app` | `package` | |
| `open_link` | `url`, optional `package` | |
| `permissions` | `package`, `grant` (names like `CAMERA`, or `all`), `revoke` | |
| `apps` | `filter` (lists installed apps) | `apps: shop` |
| `logs` | `package`, `level` (V D I W E F, default W), `since` (`30s`, `2m`; default 60s), `lines` (default 50) | |

## Control flow

| Step | Parameters |
|---|---|
| `run_flow` | `file` (relative to the current flow) or inline `steps`; `vars`; `when: {visible: target}`, `{notVisible: target}` or `{true: "${!!NAME}"}` |
| `repeat` | `steps`, and `times` and/or `while: {visible \| notVisible: target}` |

Any step can take `optional: true` (skip it if its element never shows up) and `wait: ms`.
