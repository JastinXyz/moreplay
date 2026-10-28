# moreplay

Fast Android MCP server for AI agents. A small Java agent runs on the device through
`app_process` (no APK install) and holds one UiAutomation connection, so reading the screen
takes ~30 ms instead of ~3 s. The TypeScript MCP server on the laptop pushes and starts the
agent, batches steps into one request, and saves screenshots as evidence files.

Goal: an open-source alternative to mobile-mcp whose edge is speed, small token footprint, and
record once, replay without a model (`flow` tool and `moreplay run`).

## Keep the docs current

**Every change that alters behavior, layout, commands, or plans must update the docs in the
same PR**: this file, `docs/architecture.md`, `docs/reference/`, `docs/roadmap.md`, and `README.md` where
relevant. A new session should be able to read this file and know the current state without
digging through git history. If a doc says something the code no longer does, fix the doc.

## Layout

- `agent/`: device-side Java agent, built into `agent/build/moreplay.jar` (dex inside).
  `build.sh` generates `Version.java` from `package.json`, and `/ping` answers `pong <version>`.
  - `Main.java`: UiAutomation bootstrap (reflection) + minimal HTTP server.
  - `Device.java`: every op (observe, tap, type, scroll, wait_*, key, screenshot).
  - `build.sh`: javac + d8 against the newest installed Android platform.
- `src/`: TypeScript MCP server.
  - `device.ts`: adb, device selection, push/start/stop of the agent, HTTP client.
  - `index.ts`: CLI entry (`moreplay` = MCP server, `doctor`, `run`, `export`, `import`, `--version`, `--help`).
  - `server.ts`: MCP tool registration (`observe`, `act`, `screenshot`, `flow`), the active
    recorder, and process lifecycle.
  - `help.ts`: the MCP `instructions` sent on connect, and `flow {action: "help", name}`, which
    serves `docs/reference/<topic>.md`.
  - `flow.ts`: flow YAML format (short form `- tap: Masuk`), recording (refs -> the selector the
    agent reports), `${var}` substitution, implicit waits, `runFlow`, `patchSteps`.
  - `run-cli.ts`: `moreplay run <flow|folder>... [--var k=v] [--evidence dir] [--include-tags]
    [--exclude-tags] [--junit file]` (replay with no model, exit 0/1; a folder = its top-level .yaml files, run
    one after another on one agent, then a suite summary). Prints each step live via the
    agent's streamed `/run`.
  - `report.ts`: test-runner style output for `run` (aligned ✓/✗ lines, PASS/FAIL badge;
    colors only on a TTY without `NO_COLOR`). Labels come from the flow, so `${vars}` stay hidden.
  - `maestro.ts`: flow <-> Maestro YAML (`toMaestro`, `fromMaestro`); unmapped steps are
    returned in `skipped`. `maestro-cli.ts`: `moreplay export` / `import`.
  - `doctor.ts`: setup checks (adb, device state, API level, UiAutomation conflicts, agent
    start, observe timing, inject permission via invisible KEYCODE_UNKNOWN).
  - `act.ts`: `act` batching (agent ops vs host ops), host ops (launch, stop_app, clear_app, apps,
    screenshot), output formatting. Depends on the `ActDevice` interface so tests use a fake.
- `test/`: `node:test` suites against `dist/` (no device needed). `act.test.mjs` uses a fake
  device; `tools.test.mjs` checks the tool list, a 3700-char budget for tool definitions (JSON), and
  `flow show`/`patch` on a path;
  `cli.test.mjs` covers `--version`, `--help`, unknown commands; `flow.test.mjs` covers the
  YAML form, recording, vars, waits, runFlow pass/fail, patch, save/load; `maestro.test.mjs`
  covers both directions, a round trip, and the export/import CLIs; `report.test.mjs` covers
  step labels, plain/colored output and the suite summary.
- `assets/moreplay.jar`: copy of the built jar that ships in the npm package (gitignored).
- `docs/architecture.md`: how the pieces talk, the agent protocol, the step format (internal).
- `docs/reference/`: user-facing reference (steps, selectors, flows, cli). Ships in the npm
  package and is what `flow help` returns, so a behavior change updates it too; it is also
  meant to become the website's reference pages.
- `docs/roadmap.md`: what is done, what is next. Update it when a roadmap item lands.
- `spike/`: benchmark scripts and `RESULTS.md` (measurements vs `uiautomator dump`/mobilecli).
  `mcp-test.mjs` taps the calculator (changes its state); `bench.mjs` is read-only;
  `e2e.mjs '<json [[tool, args], ...]>'` runs MCP calls in one server session (cwd `spike/`, so flows and
  evidence land in `spike/.moreplay/`; gitignored, as is `spike/evidence/` for e2e images).
- `.github/`: CI workflow, Release workflow (publishes on a `v*` tag), PR template, bug report
  template. `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE` (MIT).

## Commands

```bash
npm install
npm run build          # agent jar + copy to assets/ + tsc
npm run build:agent    # agent only
npx tsc                # server only
npm test               # tsc + unit tests (no device)
node dist/index.js doctor   # checks the connected device (starts the agent, no taps)
npm pack --dry-run     # what would ship to npm
node spike/bench.mjs   # timing against a connected device (taps nothing)
```

Needs `ANDROID_HOME` with a platform and build-tools for the agent build, JDK 11+, Node 20+.
On the owner's Mac: `ANDROID_HOME=~/Library/Android/sdk` (platform 35 + build-tools 35.0.0,
installed with Homebrew's `sdkmanager`). Server-only changes need just `npx tsc`, since
`assets/moreplay.jar` from the last build is reused.

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
- The repo is public (MIT) and published to npm as `moreplay` since 0.1.0 (2026-10-28). Merging to
  `main` releases nothing; keep `main` releasable (CI green).
- **Changelog:** a PR that changes what users see (behavior, CLI, tools, flow format) adds a line
  under `## [Unreleased]` in `CHANGELOG.md`.
- **Releases:** a PR `chore(release): X.Y.Z` bumps `version` in `package.json` (and the lock file)
  and turns `[Unreleased]` into `## [X.Y.Z] - date` with a compare link. After the owner's OK and
  the merge, ask before tagging, then `git tag vX.Y.Z && git push origin vX.Y.Z` on that commit:
  `.github/workflows/release.yml` checks the tag matches `package.json`, builds, tests, publishes
  to npm via trusted publishing (OIDC, no token or OTP) and makes the GitHub release from the
  changelog section. `X.Y.Z-next.N` goes to the `next` npm tag as a prerelease.
- **Semver in 0.x:** patch = fixes only; minor = features or anything that can break users. Breaking
  means: flow YAML format, MCP tool names or parameters, CLI flags, the `.moreplay/` layout, minimum
  Node or Android. Saved flows must keep working, or the changelog says how to update them.
- **The test device is the owner's personal phone.** Ask before every device session, even if
  you used it earlier in the same conversation. Never tap near
  the status bar or quick settings, never type into apps that hold user data, and undo any
  state you change. Benchmarks must use read-only ops or taps on known-empty areas.
- Always stop what you started on the device: the agent dies with the server, but check
  `adb shell ps -A | grep app_process` and `adb forward --list` after experiments.
- scrcpy can run alongside the agent (it does not use UiAutomation); the owner often mirrors
  the phone with it.
- Only one UiAutomation client can exist per device. Stop mobilecli / Appium / Maestro /
  uiautomator2 before running the agent (and vice versa).

## Gotchas learned the hard way

- Public `UiAutomation.injectInputEvent(ev, true)` waits for animations (~1 s per tap). The
  agent uses the hidden 3-arg variant with `waitForAnimations=false`.
- `pkill -f <pattern>` run through `adb shell` matches its own shell and kills it. Use the
  `[x]` trick (`pkill -f 'Mai[n]'`).
- `org.json` from the Android stub throws checked `JSONException`; declare or avoid it.
- Refs (`@4`) live in the agent process: they are only valid within one server session, right
  after an observe. Recording turns them into `id`/`text` selectors for that reason.
- A screenshot taken right after a tap catches the old screen. Screenshot steps wait for the
  tree to stay unchanged for 400 ms first (found when a replay saved the wrong evidence).
- Scroll actions are async: comparing the tree right after `wait_idle` can see the old list and
  call it the end. The agent waits for the tree to change first (`waitChange`).
- While a popup/dialog is modal, `getWindows()` returns only it; the activity behind is
  genuinely not reported. Use the `windows` debug op to see what the system lists.
- React Navigation keeps earlier screens mounted as full-size siblings and they still report
  `isVisibleToUser`. `coveredScreens` in `Device.java` skips earlier siblings whose content
  mostly lies under the content of a later one that fills the parent; every traversal
  (observe, text folding, selectors) uses it. Compare content, not bounds: an ad container
  fills the WebView but starts below its "Lanjut ke aplikasi" header.
- Bounds of a card under a (floating) tab bar include the hidden part, so its center can land on
  the bar. Observe cuts later siblings top-down (`walk` passes `covers`), selectors use
  `visibleRect` (walks up the parents). Keep the two in sync.
- The agent's accessibility node cache can go stale for good on WebView content (no
  content-changed event), but clearing it on every read made observe ~10x slower. It is
  cleared only while polling (`clearCacheEvery(1000)`) and before an observe after a screen
  with a WebView (`sawWebView`). Benchmark the launcher after touching this.
- `takeScreenshot()` returns a hardware bitmap: copy it to ARGB_8888 before drawing it on a
  Canvas. And never `drawText` in the agent: app_process has no default Typeface and aborts
  (SIGABRT in `Typeface::resolveDefault`), taking the agent down.
- When the agent dies mid-session, `ensureAgent` restarts it and reuses the existing forward
  (a new `adb forward tcp:0` per restart leaked the old one).
- The MCP server must exit on stdin close and remove its `adb forward` in the exit handler,
  or forwards pile up.
- A keyboard opening after a tap on a field is not listed for a few hundred ms. `hide_keyboard`
  that returned "already hidden" then let it appear, and the next tap only closed it (React
  Native's ScrollView default `keyboardShouldPersistTaps`), so a login replay stuck on its form.
  It now waits until the keyboard has stayed hidden for 400 ms.
- `am start` returns before the new activity is in front: a `wait_for` right after `launch` matched
  text on the previous app's screen. `launch` uses `am start -W`.
- `scroll {until: "Text"}` (a string) was silently ignored by the agent, so the step scrolled once
  and passed without checking. Short forms must be handled wherever a selector is read.
- Xiaomi/HyperOS needs "USB debugging (Security settings)" for input injection (the owner's
  rooted POCO X5 worked without a visible error; unproven on stock devices).
