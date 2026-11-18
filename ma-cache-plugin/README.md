# ma-cache-plugin

Warns when the prompt cache does not work. Each problem becomes one
diagnostic with source `cache.anomaly`: a warning, or info for an expected
miss. Each frontend shows it in its own way: the TUI as a scrollback chip
(warnings only), the web in the Trace Diagnostics tab, and ACP as a
`warning` notice (`ma-acp-plugin/diag-notices.ts`, warnings only). The
plugin adds no text to the system prompt.

## How it works

The plugin uses the `network:observe` capability to read a copy of each
provider request and response. It needs no core hook and changes no
traffic.

- Request: counts the `cache_control` markers, the longest marker `ttl`
  (no `ttl` is 5 minutes), the prefix size, and the start time. It also
  makes a prefix fingerprint: a hash of `tools`, a hash of `system`, a
  hash of the other request options (the body without `messages`, `tools`,
  `system`, `max_tokens`, `stream`, `metadata` and `diagnostics`, plus the
  sorted `anthropic-beta` request header), one hash for each message, the
  index of the last message with a marker, and the indexes of the assistant
  messages that have thinking. The hashes are computed without
  `cache_control`, and an assistant message is hashed without its
  `thinking` and `redacted_thinking` blocks. The body is parsed one time,
  and only the hashes and indexes are kept.
- Response: reads the `request-id` header when the host gives it,
  `cache_read_input_tokens` and `cache_creation_input_tokens` (SSE or JSON,
  gzip or plain), the server's miss reason
  (`message.diagnostics.cache_miss_reason`, sent with the
  `cache-diagnosis-2026-04-07` beta), and the end time.

The watcher turns these into one `CacheFacts` record for each request
(`detector.ts`). The detector reads only that record, so a later host event
with the same facts can replace the wire watcher (design note:
`research/team/walter/2026-11-18-cache-anomaly-per-provider.md`).

It keeps one history for each session, model and endpoint origin, and checks:

| Code                   | Level | When                                                                                                                                        |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `markers_ignored_cold` | warn  | markers on a large prefix, but 0 read and 0 write (once per history)                                                                        |
| `below_min_block_size` | warn  | markers on a prefix below the model's cache minimum (once)                                                                                  |
| `ttl_expired`          | info  | the cache was in use, then a read of 0 after a gap above the TTL                                                                            |
| `server_miss`          | info  | a read of 0 inside the TTL with an unchanged prefix, and no thinking removed or the previous turn read its cache: likely a server-side miss |
| `prefix_changed`       | warn  | a read of 0 inside the TTL that the client caused, or a server miss size larger than the read                                               |

The prefix check compares the fingerprint with the one of the previous
request: the tools, the system prompt, the request options, and each
message up to the last marker of the previous request (the longest entry
the server can read). The client removes the thinking of the previous
latest assistant message on each turn. That removal is expected and is
not a change by itself, but it makes the entry of the previous request
unreachable: the server then reads an older entry, in a limited lookback
from the new marker.

- The tools, the system prompt or the request options changed:
  `prefix_changed`, and the text says which one.
- An older message changed: `prefix_changed`, with the index of the first
  changed message. A shorter history is a removed message.
- Thinking removed from another assistant message (not the previous latest
  one with thinking): `prefix_changed`, "thinking removed from message i".
- All equal and a read of 0: `server_miss` (info) only if no thinking was
  removed, or the previous request read its prefix (read at least 90% of
  read + write). The text says "likely a server-side miss" and gives the
  `request-id` when it is known. It is a likely cause, not a proven one.
- All equal except the expected thinking removal, a read of 0, and the
  previous request read less than 90%: `prefix_changed`, "thinking removal
  - cache lookback: no reachable cache entry". The previous turn already
    read an old entry, so no entry is in reach of the lookback any more.
- All equal except the expected thinking removal, and a partial read with
  the server reason `messages_changed`: no diagnostic when the turn wrote
  at most 10% of its prompt (read + write). That is the normal cost of the
  removal. A larger write is `prefix_changed`, "thinking removal; the read
  stays on an older entry": each turn reads the same old entry and writes
  the rest again.
- A request without a fingerprint (for a host event with no hashes), or a
  turn where only one side has one: the text gives only the server's
  reason, as before.

`prefix_changed` and `server_miss` print the server's reason when it sent
one (for example `messages_changed`), as a hint. The server's
`cache_missed_input_tokens` is shown as the "server-reported miss size". It
is not the number of tokens lost: the server reports it also on turns that
read most of the prefix. The real cost of a miss is the tokens written,
which each message gives.

Misses in a row are a streak: the first `prefix_changed` warns, and the
warning comes again at 3, 10, 30, 100, ... misses, with the tokens written
since the first. A turn that reads with no miss ends the streak.
`ttl_expired` also ends it. A `server_miss` does not start, extend or end
the streak. The thinking-removal cases above are `prefix_changed`, so they
start and extend the streak.

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
  `prefix_changed` after a credential or effort switch.
- **A reset hides some real misses, on purpose.** After a reset, the first
  turn on the new target cannot be told apart from the normal cold start.
  So `prefix_changed` needs two turns of new history before it can fire
  again. The per-turn checks
  (`markers_ignored_cold`, `below_min_block_size`) still work at once. A
  reset can hide a warning, and it never makes a false one. Also, a reset
  starts the "one time per code" count and the streak again.
- **A response that is in flight during a reset is not counted.** The core
  lets a switch come while a response of the old target still streams. Each
  request records the reset epoch when it starts. If a reset came before
  its response ends, the plugin drops that usage, because it belongs to the
  old target. So the old target cannot seed the new history.

## Files

- `start.ts`: attaches the wire watcher from a headless prompt fragment
  (the headless entry that gets `ctx.host`), and keeps the histories.
- `wire-watch.ts`: reads requests and responses, and calls the detector.
- `detector.ts`: `CacheFacts`, the prefix comparison and the checks. The
  sink is injected (`ctx.log`).
- `on_target_switch.ts`: the `target.didSwitch` handler.
