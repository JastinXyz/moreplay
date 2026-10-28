# Changelog

What changed in each release, newest first. Versions follow [semver](https://semver.org); while
in 0.x, a minor bump (0.x.0) may break things and a patch (0.x.y) only fixes them.

## [Unreleased]

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

[Unreleased]: https://github.com/JastinXyz/moreplay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JastinXyz/moreplay/releases/tag/v0.1.0
