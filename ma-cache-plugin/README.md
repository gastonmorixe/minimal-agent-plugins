# ma-cache-plugin

Tells you when the prompt cache breaks. Each break is one `cache.didBreak`
bus event (see [Break events](#break-events)), whatever the cause. Each
problem also becomes one diagnostic with source `cache.anomaly`: a warning,
or info for an expected miss. Each frontend shows the diagnostic in its own
way: the TUI as a scrollback chip (warnings only) and the web in the Trace
Diagnostics tab. Each break also writes one `cache.break` notice
diagnostic, and ACP turns it into a notice (see
[Break events](#break-events)). The plugin adds no text to the system
prompt.

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

| Code                   | Level | When                                                                                                                                                                                          |
| ---------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markers_ignored_cold` | warn  | markers on a large prefix, but 0 read and 0 write (once per history)                                                                                                                          |
| `below_min_block_size` | warn  | markers on a prefix below the model's cache minimum (once)                                                                                                                                    |
| `ttl_expired`          | info  | the cache was in use, then a read of 0 after a gap above the TTL, and the prefix is unchanged (or not known). The text gives the tokens written and lost                                      |
| `server_miss`          | warn  | a read of 0 inside the TTL with an unchanged prefix, and no thinking removed or the previous turn read its cache: likely a server-side miss. Gives the request id. Warns at 1, 3, 10, 30, ... |
| `prefix_changed`       | warn  | a read of 0 that the client caused, or a server miss size larger than the read. After an idle gap, the text says the session was also idle                                                    |

A break is the same fact in each row: the previous turn of the history
read or wrote the cache, and this turn did not read that prefix. The two
cold codes are a break only after a turn that used the cache. The level
says only how loud the log is. It does not say if a break happened. The
break event does.

Two breaks have no code of their own (cause `unknown` in the event):

- Markers, 0 read and 0 write after a turn that used the cache: "the
  server neither read nor wrote the cache". `written` is 0. The cold
  warning above stays one time for each history.
- A request with no `cache_control` markers and a read of 0, after a turn
  that used the cache: "the request had no cache_control markers". No
  diagnostic. That turn is then the previous turn of the next comparison.
  (The wire watcher today skips a request with no marker, so a host event
  is the source of this case.)

The prefix check runs first, before the time check. So a client change
after an idle gap is `prefix_changed`, not `ttl_expired`. `ttl_expired` is
only for an unchanged prefix (the expected thinking removal included), or
a turn where one side has no fingerprint.

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
- All equal and a read of 0: `server_miss` (warn) only if no thinking was
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
  removal. It is still a break: the event has the cause
  `thinking_older_entry` and `actionable: false`. A larger write is `prefix_changed`, "thinking removal; the read
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
`ttl_expired` and the small-write thinking case also end it. A
`server_miss` does not start, extend or end the streak. The thinking-removal
cases above are `prefix_changed`, so they start and extend the streak. This
streak is only for the warnings. The break event counts its own streak.

`server_miss` has its own count of turns in a row, for its warning only. It
stays a warning, and it warns at the same milestones (1, 3, 10, 30, ...),
with "N server misses in a row" when N is more than 1. A clean read, a
`ttl_expired`, and a break with another cause end the count. The break
event and the `cache.break` diagnostic are sent for each `server_miss`.

## Break events

Each break sends one `cache.didBreak` event on the bus, through `ctx.emit`.
The payload is `CacheBreakPayload`
(`@minimal-agent/core/plugin-api/types/cache-break`). There is no
once-per-code limit and no milestone limit: 5 breaks in a row are 5 events.
A turn that reads its prefix sends none.

- `sessionId`, `model`, `origin`: the history of the break.
- `turn`, `prevTurn`: this turn and the turn before it.
- `expectedRead`: the previous read + write. The most this turn could read.
- `read`, `written`: the counts of this turn.
- `lost`: `expectedRead - read`, at least 0. The tokens written again.
- `gapSec`, `ttlSec`, `idle`: the gap, the TTL, and true when the gap is
  above the TTL. `idle` is set for each cause.
- `cause`: `ttl_expired`, `prefix_changed`, `thinking_lookback`,
  `thinking_older_entry`, `server_miss`, or `unknown` (no fingerprint on
  one side, a server miss that no client change explains, a cold turn with
  markers, or a request with no marker).
- `changed`, `changedIndex`: the changed part and the message index.
- `serverReason`, `serverMissedTokens`, `requestId`: the server's hints.
- `streak`, `streakLost`: breaks in a row (any cause) and the tokens lost
  since the first. A turn that reads with no break ends it.
- `actionable`: false for `ttl_expired` and for the small-write
  `thinking_older_entry`. True for the others.
- `message`: one line of plain text, for example
  `cache broke on turn 5: 48,213 tokens rewritten (idle 63 min > 5 min TTL)`.
- `at`: the response end, in epoch ms.

A frontend must show breaks from this event, not from the log level. The
log hides info lines in the TUI, so an idle expiry is not seen there as a
`cache.anomaly` line. A frontend can style a break by `actionable`. It
must not hide one by it. A host without `ctx.emit` drops the events, and
the diagnostics still work.

Each break also writes one diagnostic with source `cache.break`, at notice
level (`ctx.log.notice`). It is the same fact, for a host without bus
access. The message is the payload `message`. The structured data is the
scalar payload fields that are set: `cause`, `turn`, `prevTurn`, `read`,
`written`, `lost`, `expectedRead`, `gapSec`, `ttlSec`, `idle`, `changed`,
`changedIndex`, `serverReason`, `serverMissedTokens`, `requestId`,
`streak`, `streakLost` and `actionable`. The loader routes it to the session of the run that made the
request.

- ACP (`ma-acp-plugin/diag-notices.ts`) sends a notice for each
  `cache.break`: `warning` when `actionable`, else `info`. A client without
  `session.notices` gets the notice as answer text, so it gets only an
  actionable break with `streak` 1 (the start of a streak), or an
  actionable break after a break that was not actionable (the previous
  `cache.break` on the connection), or the first `cache.break` of the
  connection (it can have `streak` above 1, for example after a resume).
  The `streak` counts every cause, so a
  `prefix_changed` after a `ttl_expired` is sent. ACP sends no
  notice for the `cache.anomaly` codes that are also a break
  (`prefix_changed`, `server_miss`, `ttl_expired`).
- The TUI does not show notice diagnostics (the scrollback shows warnings
  and worse, the footer uses notice only for `recovery`). It shows breaks
  from the bus event, so a break is not shown two times.

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
  (the headless entry that gets `ctx.host`), keeps the histories, and sends
  the break events through `ctx.emit`.
- `wire-watch.ts`: reads requests and responses, and calls the detector.
- `detector.ts`: `CacheFacts`, the break definition, the prefix comparison
  and the checks. The sink (`ctx.log`) and the break target are injected.
- `on_target_switch.ts`: the `target.didSwitch` handler.
