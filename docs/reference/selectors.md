# Selectors

How a step says which element it means. Used by `tap`, `long_press`, `type`, `wait_for`,
`wait_gone`, `scroll {until}`, the anchors of position keys, `run_flow {when}`, `repeat {while}`
and the `dismiss` list.

## Basic targets

| Key | Matches | Example |
|---|---|---|
| `text` | visible text or content description. Exact match first, then "contains"; case-insensitive | `tap: {text: Sign in}` |
| `id` | resource id, full (`com.app:id/login`) or the part after `:id/` | `tap: {id: login}` |
| `desc` | content description only | `tap: {desc: Back}` |
| `ref` | `@n` from the latest `observe`. Valid in the same session only; recording turns it into id or text | `tap: {ref: 12}` |
| `x`, `y` | a point, in pixels or a percentage of the screen | `tap: {x: "50%", y: 1200}` |

A plain string is short for `text`: `tap: Sign in` = `tap: {text: Sign in}`.

When the match is not clickable itself (a label inside a button), the tap goes to its nearest
clickable parent.

## Regex

Text written between slashes is a regular expression, case-insensitive:

```yaml
- wait_for: "/Total: \\d+/"
- tap: {text: "/^(OK|Allow)$/"}
```

A whole-text match counts as exact, a match inside the text as contains. Text without slashes is
never a regex, so `Search...` means those characters.

## Position: below, above, leftOf, rightOf

Pick an element by where it is relative to another one (the anchor). The anchor is a target
too: a string, or `{text|id|desc}`, and it may have position keys of its own.

```yaml
- tap: {text: "1", below: Enter your PIN}        # keypad digit under the prompt
- tap: {above: Total, rightOf: Unpaid}           # an unlabeled icon, found by its neighbours
```

Among the matches (or, without text/id/desc, every tappable element), moreplay keeps the ones
past that edge of every anchor and picks the nearest. An exact text match still beats a contains
match. Elements hidden under a sheet or bar never count. If the anchor is missing, the step
waits for it like for any target.

## index

`index: n` (0-based) picks the n-th match. Without position keys, it counts in reading order
(top to bottom, then left to right). With position keys, it counts nearest first.

```yaml
- tap: {id: otp-input, index: 0}
```

## State and nesting

| Key | Keeps |
|---|---|
| `enabled`, `checked`, `selected`, `focused` | matches in that state (`true` / `false`) |
| `childOf: target` | elements inside a match of the target |
| `containsChild: target` | elements that have a descendant matching the target |

```yaml
- tap: {text: Delete, childOf: {id: row_3}}
- tap: {containsChild: {text: Wi-Fi}, checked: false}
```

## Waiting

In replays (`flow run`, `moreplay run`) every targeted step waits up to 5 s for its element to
show up, not be covered (a splash screen, a sheet still on top) and be enabled. A coordinate tap
waits for the screen to stop moving instead. In `act`, steps after the first wait 3 s. Set
`wait: ms` on a step to change it, and `optional: true` to skip a step whose element never shows.
