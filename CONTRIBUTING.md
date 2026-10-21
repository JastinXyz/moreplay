# Contributing

Thanks for helping. droidreplay is small on purpose: a Java agent on the device and a
TypeScript MCP server on the laptop. Read `docs/architecture.md` first.

## Setup

- Node 20+, JDK 11+, Android SDK with one platform and build-tools (`ANDROID_HOME` set)
- An Android device or emulator with USB debugging

```bash
npm install
npm run build
```

## Pull requests

- Branch from `main`, one topic per PR, Conventional Commits (`feat(agent): ...`).
- `npm run build` must pass (CI runs it).
- Say which device and Android version you tested on. OEM differences are the main source of
  bugs, so reports from more devices are very welcome.
- Update the docs in the same PR when behavior changes.

## Device etiquette

Test against an emulator or a spare device when you can. If a change needs taps, restore the
state you changed and avoid the status bar and quick settings.
