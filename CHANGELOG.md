# Changelog

What changed in each release, newest first. Versions follow [semver](https://semver.org); while
in 0.x, a minor bump (0.x.0) may break things and a patch (0.x.y) only fixes them.

## [Unreleased]

## [0.2.0] - 2026-10-28

Upgrading from 0.1: flows that passed may now fail early where they used to pass by accident.
A `${NAME}` passed empty (`--var NAME=`) now fails before the run; test optional vars with
`${!!NAME}`. A `type` into a field that refuses the text now fails at that step. Taps are
roughly 100-200 ms slower because they wait for a still target.

- Screens raised with zIndex (React Native) are read in their real stacking order. A PIN lock
  over the home screen was hidden from `observe` and from selectors, so a tap meant for the home
  behind it landed on the lock's keypad.
- `type` fails at once when the field stays empty (it refused the characters), instead of the
  flow failing a minute later on an unrelated wait.

- `moreplay run` prints the steps inside `run_flow` and `repeat` as they finish (indented), and
  `… still running (N s ...)` when nothing has printed for 15 s. A whole subflow used to be one
  silent line, which looked like a hang during a long wait.
- While `moreplay run` replays, the MCP server and `doctor` answer "device busy" instead of
  taking the device and silently stopping the run's agent.
- A request whose agent dies midway fails at once ("the agent stopped in the middle of this
  request ...") instead of waiting out its whole time budget.

- `type {field}` finds filled fields too (by hint), and fields by the label right above them.
  It used to fail with "no focused text field" once a field had a value.
- A selector tap closes the keyboard first when the target is not a field, so apps that spend
  the first tap on closing it (React Native) no longer need two taps.
- A selector tap waits for its target to stop moving (a list closing, a calendar sliding up)
  before tapping. Costs roughly 100-200 ms per tap.
- The first targeted step in `act` waits up to 1 s for its element (an empty screen right after
  the agent restarted failed it at once).
- No partial-match note when a regex matched inside a label.

- Recording saves steps inside `repeat` and `run_flow` in the short form (`- tap: A`, not
  `- op: tap`).
- `moreplay run` shows how many rounds a `repeat` ran (`ran 0x` in yellow).
- Screenshots taken by `act` while recording go to a temp folder, not a `.moreplay/` folder in
  the AI app's working directory.
- The MCP instructions say to replay a flow right after saving it, and that `repeat {while}` /
  `run_flow {when}` check the screen without waiting.

- A `${NAME}` whose value is empty fails before the flow runs, naming the var. It used to type
  nothing, pass, and fail much later with an unrelated timeout. `${!!NAME}` still accepts empty.
- A selector tap reports the label it hit, and `(partial match for "x")` when the text only
  matched inside a longer label.
- `wait_gone` on something that was never on screen says `not on screen (nothing to wait for)`
  instead of a normal "gone after".

- The MCP server sends `instructions` on connect (how to batch, record and replay), and
  `flow {action: "help", name}` returns the full reference for steps, selectors, flows and the
  CLI. The reference ships in the package as `docs/reference/`.
- README: setup for Codex CLI, Cursor, Windsurf, Gemini CLI, Cline and VS Code, and the
  npx / global / project install options.

## [0.1.0] - 2026-10-28

First release.

- MCP server with four tools: `observe`, `act`, `screenshot`, `flow`. A Java agent on the
  device holds one UiAutomation connection, so reading the screen takes ~50 ms. Nothing is
  installed on the phone.
- Record what the AI did as a YAML flow and replay it with `moreplay run`, no AI needed:
  `${vars}` and expressions, `run_flow` subflows, `repeat`, `optional`, a `dismiss` list for
  popups, tags, JUnit output, failure screenshots and crash logs.
- Selectors: text (exact, contains or `/regex/`), id, desc, position (`below`, `above`,
  `leftOf`, `rightOf`), `index`, state filters, `childOf` / `containsChild`, percent coordinates.
- Host steps: launch (with arguments), stop / clear / install / uninstall an app, deep links,
  runtime permissions, logs.
- `moreplay export` / `import` convert flows to and from Maestro YAML.
- `moreplay doctor` checks adb, the device and the agent.

[Unreleased]: https://github.com/JastinXyz/moreplay/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/JastinXyz/moreplay/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/JastinXyz/moreplay/releases/tag/v0.1.0
