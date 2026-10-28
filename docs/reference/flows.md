# Flows

A flow is a YAML file of steps that replays without an AI: from the `flow` tool (`run`) or the
terminal (`moreplay run`). Names are looked up in `.moreplay/flows/`; anything with a slash or
ending in `.yaml` is used as a path.

```yaml
name: login
tags: [smoke]                       # optional, for --include-tags / --exclude-tags
dismiss: [Not now, {id: close_ad}]  # optional: tapped away whenever they show up
steps:
  - launch: com.example.app
  - tap: Sign in
  - type: {field: Email, value: "${email}"}
  - type: {field: PIN, value: "${pin}", submit: true}
  - wait_for: Home
  - screenshot: login-ok
```

## Recording

`flow {action: record, name: login}`, then do the task with `act`, then `flow {action: save}`.
Every `act` step that succeeds is kept. Refs (`@12`) are saved as the element's id or text, so
the file works in later sessions. `flow {action: discard}` drops the recording.

Start recording before doing the task, not after exploring it: wrong turns can be removed
afterwards with `flow {action: patch, name, index, steps: []}`, which is cheaper than doing the
task twice (and creating its data twice). `observe`, `apps` and `wait_idle` are not saved,
because replays wait for each element on their own.

To keep a password or PIN out of the file, give it as a var when recording:
`flow {action: record, name: login, vars: {pin: "482913"}}`. Write `${pin}` in `act`, and the
saved flow says `${pin}` too, even where the value itself was typed.

## Variables and expressions

Pass values when replaying: `flow {action: run, name: login, vars: {pin: "482913"}}` or
`moreplay run login --var pin=482913`. A missing or empty var fails before anything runs (an
empty one is usually an env var that was never filled in). To make a var optional, test it with
`${!!NAME}`: an empty value is fine there.

| Form | Means |
|---|---|
| `${NAME}` | the value |
| `${NAME[0]}` | one character (a PIN digit) |
| `${!!NAME}` | true when set and not empty |
| `${NAME == 'x'}`, `${NAME != 'x'}` | compare |

## Things that appear only sometimes

- `optional: true` on a step skips it when its element never shows up.
- `dismiss` at the top of the file lists popups (ads, prompts) that may appear at any time.
  Whenever a step is waiting and one of them is on screen, it is tapped away.

## Subflows, conditions, loops

```yaml
- run_flow: {file: shared/login.yaml, vars: {pin: "${PIN}"}}
- run_flow:
    when: {visible: Allow notifications?}
    steps:
      - tap: Allow
- run_flow:
    when: {true: "${!!CARD}"}
    steps:
      - tap: "${CARD}"
- repeat:
    times: 5
    while: {visible: {id: next_button}}
    steps:
      - tap: {id: next_button}
```

`file` is relative to the flow that calls it. `when` is checked once on the current screen; when
it is not met the step passes as skipped. `while` is checked before each round.

## Replays and failures

Replays wait for each element (5 s by default), so flows need no sleeps. Screenshots go to
`.moreplay/evidence/<flow>/<date-time>/`.

When a step fails, the run stops and reports the step number, the error, the screen, and a
`failed-step-N.jpg` / `.txt`. Fix the step with
`flow {action: patch, name, index: N, steps: [...]}` (`steps: []` deletes it), then run again.
`flow {action: show, name}` prints a flow; `flow {action: list}` lists the saved ones.
