# droidreplay

Fast Android MCP server for AI agents. A small Java agent runs on the device through
`app_process` (no APK install) and holds one UiAutomation connection, so reading the screen
takes ~30 ms instead of ~3 s. The TypeScript MCP server on the laptop pushes and starts the
agent, batches steps into one request, and saves screenshots as evidence files.

Goal: an open-source alternative to mobile-mcp whose edge is speed, small token footprint, and
(planned) record once, replay without a model.

## Keep the docs current

**Every change that alters behavior, layout, commands, or plans must update the docs in the
same PR**: this file, `docs/architecture.md`, `docs/roadmap.md`, and `README.md` where
relevant. A new session should be able to read this file and know the current state without
digging through git history. If a doc says something the code no longer does, fix the doc.

## Layout

- `agent/`: device-side Java agent, built into `agent/build/droidreplay.jar` (dex inside).
  - `Main.java`: UiAutomation bootstrap (reflection) + minimal HTTP server.
  - `Device.java`: every op (observe, tap, type, scroll, wait_*, key, screenshot).
  - `build.sh`: javac + d8 against the newest installed Android platform.
- `src/`: TypeScript MCP server.
  - `device.ts`: adb, device selection, push/start/stop of the agent, HTTP client.
  - `index.ts`: MCP tool registration (`observe`, `act`, `screenshot`) and process lifecycle.
  - `act.ts`: `act` batching (agent ops vs host ops), host ops (launch, stop_app, apps,
    screenshot), output formatting. Depends on the `ActDevice` interface so tests use a fake.
- `test/`: `node:test` suites against `dist/` (no device needed). `act.test.mjs` uses a fake
  device; `tools.test.mjs` checks the tool list and a ~2500-char budget for tool definitions.
- `assets/droidreplay.jar`: copy of the built jar that ships in the npm package (gitignored).
- `docs/architecture.md`: how the pieces talk, the agent protocol, the step format.
- `docs/roadmap.md`: what is done, what is next. Update it when a roadmap item lands.
- `spike/`: benchmark scripts and `RESULTS.md` (measurements vs `uiautomator dump`/mobilecli).
  `mcp-test.mjs` taps the calculator (changes its state); `bench.mjs` is read-only.
- `.github/`: CI workflow, PR template, bug report template. `CONTRIBUTING.md`, `LICENSE` (MIT).

## Commands

```bash
npm install
npm run build          # agent jar + copy to assets/ + tsc
npm run build:agent    # agent only
npx tsc                # server only
npm test               # tsc + unit tests (no device)
node spike/bench.mjs   # timing against a connected device (taps nothing)
```

Needs `ANDROID_HOME` with a platform and build-tools for the agent build, JDK 11+, Node 20+.

## Working rules

- **Work through PRs.** Branch from `main` (`feat/...`, `fix/...`, `docs/...`, `chore/...`),
  open a PR with `gh pr create` using the template, give the owner the link, and **stop**.
  When the owner says it is OK, merge it yourself (`gh pr merge <n> --squash --delete-branch`),
  then start the next PR from fresh `main`. One PR at a time. Never push to `main` directly and
  never merge without the owner's OK for that specific PR.
- Conventional Commits, English. No AI attribution anywhere (no Co-Authored-By trailer, no
  "Generated with" footer). Git identity is the repo's configured `JastinXyz`.
- CI (`.github/workflows/ci.yml`) runs `npm run build` and `npm test` on every PR; keep it green.
- New server logic gets a unit test with the fake device. Keep the tool-definition budget.
- The repo is private until launch (see `docs/roadmap.md`), then it goes public under MIT.
- **The test device is the owner's personal phone.** Ask before every device session, even if
  you used it earlier in the same conversation. Never tap near
  the status bar or quick settings, never type into apps that hold user data, and undo any
  state you change. Benchmarks must use read-only ops or taps on known-empty areas.
- Always stop what you started on the device: the agent dies with the server, but check
  `adb shell ps -A | grep app_process` and `adb forward --list` after experiments.
- Only one UiAutomation client can exist per device. Stop mobilecli / Appium / Maestro /
  uiautomator2 before running the agent (and vice versa).

## Gotchas learned the hard way

- Public `UiAutomation.injectInputEvent(ev, true)` waits for animations (~1 s per tap). The
  agent uses the hidden 3-arg variant with `waitForAnimations=false`.
- `pkill -f <pattern>` run through `adb shell` matches its own shell and kills it. Use the
  `[x]` trick (`pkill -f 'Mai[n]'`).
- `org.json` from the Android stub throws checked `JSONException`; declare or avoid it.
- The MCP server must exit on stdin close and remove its `adb forward` in the exit handler,
  or forwards pile up.
- Xiaomi/HyperOS needs "USB debugging (Security settings)" for input injection (the owner's
  rooted POCO X5 worked without a visible error; unproven on stock devices).
