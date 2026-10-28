# Spike 1: app_process agent (2026-10-21)

Device: POCO X5 5G (moonstone), Android 14 (API 34), HyperOS 1.0, rooted.
Agent: `agent/` jar (4.8 KB), launched with `app_process`, one UiAutomation connection
(`FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`), HTTP on 127.0.0.1:9070 via `adb forward`.

| Operation | Old way | Agent (device time) |
|---|---|---|
| Read UI tree | `uiautomator dump`: 2.9-3.6 s, 54 KB XML | `/observe`: 12-30 ms (first call 682 ms), 3.4 KB |
| Tap | `adb shell input tap`: 184 ms | `/tap`: 94-138 ms |
| HTTP round trip over adb forward | — | ~50 ms |
| Connect UiAutomation on start | — | under 1 s |

Findings:
- UiAutomation via reflection (`UiAutomationConnection` + `UiAutomation(Looper, conn)` +
  `connectWithTimeout`) works on HyperOS 14 without installing an APK.
- Public `UiAutomation.injectInputEvent(ev, true)` waits for animations (~1.1 s per tap). Use the
  hidden 3-arg `injectInputEvent(ev, sync, waitForAnimations=false)`.
- No INJECT_EVENTS SecurityException on this device. It may already have the Xiaomi
  "USB debugging (Security settings)" toggle on, so this is not proven for stock Xiaomi devices.
- The home screen tree repeats each icon three times (container, icon, title). Merging children
  into their clickable parent should cut it to about a third.
- `mobilecli.dex` is already in /data/local/tmp, so mobile-mcp's device server likely runs via
  app_process too. A direct speed comparison has not been run yet.

Next: dedupe the tree, `wait_for` on device, `batch`, then the TS MCP server.

# Spike 2: agent v2 + MCP server, vs mobilecli (2026-10-21)

Same device. moreplay timings are end to end from an MCP client on the laptop.
mobilecli 1.0.21 (what mobile-mcp 1.0.12 uses) timed per CLI call, with and without its daemon.

| Operation | mobilecli | moreplay |
|---|---|---|
| Read UI tree, warm | `dump ui` 2.2-3.3 s (120 KB JSON); `snapshot` 2.6-3.2 s (15 KB). Daemon: no change | `observe` 21-55 ms (2.2 KB on the calculator) |
| Read UI tree, cold | 11 s first call | ~1-4 s (push jar + start agent) |
| Tap x,y | 115-309 ms | 77-94 ms |
| Screenshot to file | 836-1220 ms (PNG) | 61-99 ms (JPEG q85, full res) |
| Tool definitions | ~6.5-7.5k tokens (mobile-mcp, 34 tools) | ~457 tokens (3 tools) |

Findings:
- mobilecli also runs `app_process / com.mobilenext.mobilecli.DeviceServer` (30 min idle
  timeout), so "no APK install" is not a differentiator. Its tree read is still ~2-3 s.
- Home screen tree after folding text into clickable parents: 1.7 KB / 30 lines (was 3.4 KB).
- Batch of 6 steps (open drawer, wait_idle, scroll until "Kalkulator", tap, wait_for, home)
  ran in one request in ~5 s, with no model call in between. Scroll is the slow part (each
  swipe waits for the list to settle).
- A failed step stops the batch and returns the current screen, which is what a model needs
  to fix the step.
- `pkill -f <class>` from `adb shell` kills its own shell; use the `[x]` pattern trick.
- Benchmark lesson: never tap near the status bar. A tap at 540,60 pulled down the shade.

# Re-run for the README (2026-10-27)

Same device, agent at 0.1.0 after the covered-screen, icon and scroll changes. Read-only:
`node spike/bench.mjs` on the home screen, and `adb exec-out screencap -p > file` five times.

| Operation | Result |
|---|---|
| `observe` warm (MCP client, end to end) | 36-60 ms, 948 B |
| `observe` cold (starts the agent) | 1.6 s |
| `screenshot` tool to file | 158-171 ms (first call 508 ms) |
| plain adb `screencap -p` to file | 1.1-1.4 s, 1.4 MB PNG at 1080x2400 |

Observe is a little slower than Spike 2's 21-55 ms (on the calculator) and screenshots
slower than its 61-99 ms; the README uses these newer numbers. Taps were not re-measured.

# Re-measure against the latest releases (2026-10-28)

Same phone, home screen, read-only. Latest releases at the time: mobilecli 1.0.21 (17 Oct,
the version Spike 2 measured) and mobile-mcp 1.0.14 (26 Oct).

mobile-mcp 1.0.14 through an MCP client (`npx -y @mobilenext/mobile-mcp@1.0.14`), 4 calls each:

| Call | Result |
|---|---|
| Tool definitions | 34 tools, 30,010 chars of JSON (~7.5k tokens) |
| `mobile_list_elements_on_screen` | 4,695 ms first, then 1,612 / 2,355 / 2,465 ms; 14,334 chars (status bar included) |
| `mobile_take_screenshot` | 561 ms first, then 338 / 303 / 302 ms; the JPEG comes back inline (63,138 base64 chars) |

mobilecli 1.0.21 CLI (`npx -y mobilecli@1.0.21`, so each call also pays npx's lookup), 4 calls each:

| Command | Result |
|---|---|
| `dump ui` | 8,608 ms first, then 3,608-3,753 ms; 122 KB JSON |
| `snapshot` | 3,292-4,067 ms; 14.8 KB |
| `screenshot --format jpeg` | 1,730 ms first, then 895-986 ms (to a file) |

moreplay for comparison (same day, `spike/bench.mjs`): observe 34-65 ms warm, 1.3 s cold;
screenshot to a file 150-160 ms; tool definitions 3,397 chars (~850 tokens).

mobilecli now runs its own app_process server with one UiAutomation, like moreplay, but
waits for the UI to settle (up to 2 s, `devices/android.go`) before each dump, which is where
its read time goes. The README compares against mobile-mcp end to end, since that is what an
MCP user runs; taps were not re-measured (the bench scripts are read-only).
