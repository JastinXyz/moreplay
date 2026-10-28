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
- [x] Maestro YAML export/import (`droidreplay export` / `import`, CLI only)

## Maestro parity: real suites as droidreplay flows

What it takes for a team's existing Maestro suite (logins with a PIN keypad, sessions that may
or may not be kept, dev-build overlays) to be imported or recorded and replayed by droidreplay.

- [x] Secrets stay out of recorded flows: `flow record{vars}`, values saved back as `${var}`
- [x] `clear_app` (Maestro `clearState`) to start from a fresh install state
- [x] Position selectors `below` / `above` / `leftOf` / `rightOf`, also for unlabeled icons
- [x] Regex text (`"/A|B/"`), for waits on one of several screens and partly known text
- [ ] Conditional steps (`when: visible / not visible`) for screens that only sometimes appear
- [ ] Subflows with parameters (`run_flow{file, vars}`), e.g. a shared PIN keypad flow
- [ ] `repeat while visible`, `hide_keyboard`, `index` selector, tags to include/exclude flows

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
- [x] `act` waits briefly for selector targets after the first step (a tap into a bottom sheet
  failed in 55 ms while the sheet opened); empty fields print their hint once

## Launch

- [x] README benchmark table (from `spike/RESULTS.md`)
- [x] README demo GIFs (Claude Code driving the phone, and a no-AI replay)
- [ ] Make the GitHub repo public, publish to npm, post to communities
