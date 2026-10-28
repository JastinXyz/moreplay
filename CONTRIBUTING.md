# Contributing

Thanks for helping. moreplay is small on purpose: a Java agent on the device and a
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
- Update the docs in the same PR when behavior changes, and add a line under `[Unreleased]` in
  `CHANGELOG.md` when users would notice the change.

## Releases

Maintainers release by merging a `chore(release): X.Y.Z` PR (version bump + changelog) and pushing
the tag `vX.Y.Z`. The Release workflow publishes to npm with provenance and creates the GitHub
release. Versions follow semver; in 0.x a minor bump may break things.

## Device etiquette

Test against an emulator or a spare device when you can. If a change needs taps, restore the
state you changed and avoid the status bar and quick settings.
