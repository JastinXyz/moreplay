# Roadmap

Status as of the latest merged PR. Move items to Done when they land.

## Done

- [x] app_process agent with persistent UiAutomation, tested on Android 14 / HyperOS
- [x] Compact observe (text folded into clickable parents)
- [x] On-device ops: tap, long_press, type, swipe, scroll until, key, wait_for, wait_gone, wait_idle
- [x] MCP server with 3 tools (`observe`, `act`, `screenshot`), ~457 tokens of tool definitions
- [x] Screenshot to evidence file without sending the image to the model
- [x] Benchmarks vs `uiautomator dump` and mobilecli (`spike/RESULTS.md`)

## Next: open-source readiness

- [x] LICENSE (MIT), CONTRIBUTING, issue/PR templates
- [x] CI: build agent jar + typecheck on every PR
- [x] Unit tests for the server (step splitting, formatting) with a fake agent
- [x] npm packaging: `bin`, `files` (dist + jar, ~21 kB), `prepack` build, versioned agent,
      md5-based push. Publishing itself happens at launch.
- [x] `doctor` command: checks adb, device, Xiaomi toggle, UiAutomation slot

## Then: the differentiator

- [x] Recorder: successful `act` steps recorded with selectors (not coordinates)
- [x] `replay` of a saved flow without a model (`flow run`, `droidreplay run`), evidence per run
- [x] Self-heal: on a broken step, return the step + screen so the model can patch the flow
- [ ] Maestro YAML export/import

## Quality

- [x] Faster scroll (directional scroll actions, end-of-list detection), ~2x faster per scroll
- [x] Read all interactive windows (dialogs, popups, permission prompts) + keyboard flag
- [x] Skip screens covered by a later full-size sibling (React Navigation stacks), found dogfooding
- [x] Tap the visible part of a target half under a bar; fully hidden nodes omitted (bottom sheets)
- [x] `icon` flag on unlabeled image buttons + `screenshot {refs}` crops to see them cheaply
- [ ] Test on Android 11-13 and a non-rooted device; handle hidden-API drift per version
- [x] WebView: Chromium's accessibility tree covers web content (observe, tap, type, scroll
  tested); CDP only matters for debuggable WebViews with an empty tree, so it waits for a real case
- [x] Optional steps and a flow-level `dismiss` list (interstitial ads, prompts that appear only sometimes)

## Launch

- [ ] README demo GIF + benchmark table
- [ ] Make the GitHub repo public, publish to npm, post to communities
