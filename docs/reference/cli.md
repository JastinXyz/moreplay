# Command line

```text
moreplay                 the MCP server on stdio (what AI apps start)
moreplay doctor          check adb, the phone and the agent (taps nothing)
moreplay run ...         replay flows without an AI
moreplay export ...      flow -> Maestro YAML
moreplay import ...      Maestro YAML -> flow
moreplay --version
```

With `npx`, put `-y moreplay` first: `npx -y moreplay run login`.

## run

```bash
moreplay run <flow|folder>... [--var key=value]... [--evidence dir]
             [--include-tags a,b] [--exclude-tags c] [--junit report.xml]
```

- A flow is a name in `.moreplay/flows/` or a `.yaml` path. A folder runs every `.yaml` directly
  in it, sorted by name (subfolders are for subflows).
- Each step prints as it finishes, including the steps inside `run_flow` and `repeat`
  (indented). A step quiet for 15 s or more gets a `… still running` line. With more than one
  flow, a summary closes the run.
- While it runs, it marks the device as busy: an MCP server (or `doctor`) answers "device busy"
  instead of taking the device from it.
- `--include-tags` runs flows with any of those tags; `--exclude-tags` skips flows with any.
- `--junit` writes a JUnit XML report for CI.
- Exit code: 0 when every flow passed, 1 when one failed or none matched, 2 on bad usage.
- Colors are on in a terminal; `NO_COLOR=1` turns them off, `FORCE_COLOR=1` forces them.

## export and import

```bash
moreplay export <flow> [--app-id package] [--out file]
moreplay import <maestro.yaml> [--name flow-name] [--out file.yaml]
```

Steps with no counterpart are listed on stderr, never dropped silently. Maestro reads text as a
regex while moreplay matches exact-then-contains, so check labels with special characters.

## Environment

| Variable | Use |
|---|---|
| `ANDROID_SERIAL` | the device to use when several are connected |

Only one tool can control a phone's UI at a time. Stop mobile-mcp, mobilecli, Maestro, Appium or
uiautomator2 before using moreplay; `doctor` and the error message name the one in the way.
