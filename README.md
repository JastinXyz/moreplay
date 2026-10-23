# droidreplay

Fast Android MCP server. Let the AI walk a flow once, then replay it with no model at all. An 11 KB agent runs on the device through `app_process` (no APK to
install) and keeps one UiAutomation connection open, so reading the screen takes ~30 ms
instead of ~3 s, and a whole batch of steps runs in one request.

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
dismiss: [Nanti saja]          # tapped away whenever it shows up (ads, prompts)
steps:
  - launch: com.example.app
  - tap: Masuk
  - type: {field: Email, value: "${email}"}
  - wait_for: Beranda
  - screenshot: login-ok
```

```bash
droidreplay run login --var email=qa@example.com   # exit code 0 = passed
```

Screenshots land in `evidence/<flow>/<timestamp>/`. Works in CI with a device or emulator.

## Notes

- Only one UiAutomation client can run at a time. Stop Appium, Maestro, uiautomator2 or
  mobilecli before using droidreplay.

See `spike/RESULTS.md` for measurements, `docs/architecture.md` for how it works, and
`docs/roadmap.md` for what is next.
