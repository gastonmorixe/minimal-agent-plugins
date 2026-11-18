# ma-cache-plugin

Warns when the prompt cache does not work. Each problem becomes one
warn-severity diagnostic with source `cache.anomaly`. Each frontend shows it
in its own way: the TUI as a scrollback chip, the web in the Trace
Diagnostics tab, and ACP as a `warning` notice (`ma-acp-plugin/diag-notices.ts`).
The plugin adds no text to the system prompt.

## How it works

The plugin uses the `network:observe` capability to read a copy of each
provider request and response. It needs no core hook and changes no
traffic.

- Request: counts the `cache_control` markers and the prefix size.
- Response: reads `cache_read_input_tokens` and `cache_creation_input_tokens`
  (SSE or JSON, gzip or plain).

It keeps one history for each session, model and endpoint origin, and checks:

| Code                   | When                                                |
| ---------------------- | --------------------------------------------------- |
| `markers_ignored_cold` | markers on a large prefix, but 0 read and 0 write   |
| `below_min_block_size` | markers on a prefix below the model's cache minimum |
| `no_read_after_write`  | the last turn wrote the cache, and this turn read 0 |
| `cache_evicted`        | reads climbed over two turns, then fell to 0        |

Each code is sent at most one time for each history.

## Limits

- **Wire shape.** Only the Anthropic Messages shape (`cache_control` markers
  and the `cache_*_input_tokens` usage fields) is checked. A provider with
  automatic caching (no markers) is not checked.
- **Target switch needs a host event.** A change of model or endpoint starts
  a new history by itself (the key changes). A change of credential or
  effort keeps the same key, so the plugin resets on the `target.didSwitch`
  bus event. Today only the CLI sends that event (TUI and ACP host mode,
  `minimal-agent-cli/src/startup/live-target.ts`). A host that does not
  send it (the web host, or a third-party host) can get one false
  `cache_evicted` or `no_read_after_write` after a credential or effort
  switch.
- **A reset hides some real misses, on purpose.** After a reset, the first
  turn on the new target cannot be told apart from the normal cold start.
  So `no_read_after_write` needs two turns and `cache_evicted` needs three
  turns of new history before they can fire again. The per-turn checks
  (`markers_ignored_cold`, `below_min_block_size`) still work at once. A
  reset can hide a warning, and it never makes a false one. Also, a reset
  starts the "one time per code" count again.

## Files

- `start.ts`: attaches the wire watcher from a headless prompt fragment
  (the headless entry that gets `ctx.host`), and keeps the histories.
- `wire-watch.ts`: reads requests and responses, and calls the detector.
- `detector.ts`: the checks. The warning sink is injected (`ctx.log`).
- `on_target_switch.ts`: the `target.didSwitch` handler.
