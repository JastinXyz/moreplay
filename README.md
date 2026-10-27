# droidreplay

Fast Android MCP server. Let the AI walk a flow once, then replay it with no model at all. A 17 KB agent runs on the device through `app_process` (no APK to
install) and keeps one UiAutomation connection open, so reading the screen takes ~30 ms
instead of ~3 s, and a whole batch of steps runs in one request.

## How fast

Reading the screen is **~60x faster** than `uiautomator dump` and mobilecli, screenshots are
**~7x faster**, and the model reads **~10x less** per screen and per request.

Measured on one phone (Android 14, HyperOS). droidreplay times are end to end from an MCP
client on the laptop. Method and raw numbers: [`spike/RESULTS.md`](spike/RESULTS.md).

**Speed** (lower is better)

| | droidreplay | mobilecli 1.0.21 | plain adb |
|---|---|---|---|
| Read the screen | **36-60 ms** | 2.2-3.3 s | 2.9-3.6 s |
| First read (starts the agent) | **1-4 s** | 11 s | 2.9-3.6 s |
| Tap x,y | **77-94 ms** | 115-309 ms | 184 ms |
| Screenshot to file | **160-170 ms** | 0.8-1.2 s | 1.1-1.4 s |

**What the model reads**

| | droidreplay | mobilecli 1.0.21 | plain adb |
|---|---|---|---|
| One screen as text | **1-2 KB** | 15-120 KB JSON | 54 KB XML |
| Tool definitions, every request | **~800 tokens** (4 tools) | ~7k tokens (34 tools) | n/a |

mobilecli is the device layer of [mobile-mcp](https://github.com/mobile-next/mobile-mcp). Plain
adb means `uiautomator dump`, `input tap` and `screencap`. A batch of steps (`act`) goes to the
device in one request, and a saved flow replays with no model call between steps.

## Requirements

- Node 20+, `adb` (uses `$ANDROID_HOME/platform-tools/adb` when set)
- An Android device with USB debugging on. Xiaomi/HyperOS also needs
  "USB debugging (Security settings)" for input injection.
- To build the agent: JDK 11+ and an Android SDK platform + build-tools.

## Build and run

```bash
npm install
npm run build
```

Check your setup (starts the agent on the device, taps nothing):

```bash
node dist/index.js doctor
```

Claude Code:

```bash
claude mcp add droidreplay -- node /path/to/droidreplay/dist/index.js
```

Once published to npm this becomes `npx -y droidreplay` and `npx droidreplay doctor`.

Env: `ANDROID_SERIAL` picks a device when several are connected; `DROIDREPLAY_EVIDENCE_DIR`
sets where screenshots go (default `./evidence`); `DROIDREPLAY_FLOWS_DIR` where flows live (default `./flows`).

## Tools

- `observe`: the screen as one line per element, `@ref Class "label" #id [x,y] flags`.
- `act`: a list of steps run in order in one call (tap, type, scroll until, wait_for,
  wait_idle, key, launch, screenshot, ...). Stops at the first failure and returns the screen.
- `screenshot`: saves a JPEG to the evidence folder and returns the path. Only sends the
  image to the model with `show: true`.
- `flow`: `record` the steps the AI takes, `save` them as YAML, `run` them again later (each
  step waits for its element), `patch` a step that broke after a UI change.

## Replay without a model

```yaml
# flows/login.yaml
name: login
dismiss: [Not now]             # tapped away whenever it shows up (ads, prompts)
steps:
  - launch: com.example.app
  - tap: Sign in
  - type: {field: Email, value: "${email}"}
  - wait_for: Home
  - screenshot: login-ok
```

```bash
droidreplay run login --var email=qa@example.com   # exit code 0 = passed
```

Screenshots land in `evidence/<flow>/<timestamp>/`. Works in CI with a device or emulator.

Flows convert to and from [Maestro](https://maestro.mobile.dev) YAML. Steps with no
counterpart (a `dismiss` list, `sleep`, Maestro's relative selectors, `runFlow`) are listed on
stderr instead of being dropped silently.

```bash
droidreplay export login > login.maestro.yaml      # then: maestro test login.maestro.yaml -e email=...
droidreplay import checkout.maestro.yaml --name checkout   # saves flows/checkout.yaml
```

## Notes

- Only one UiAutomation client can run at a time. Stop Appium, Maestro, uiautomator2 or
  mobilecli before using droidreplay.

See `spike/RESULTS.md` for measurements, `docs/architecture.md` for how it works, and
`docs/roadmap.md` for what is next.
