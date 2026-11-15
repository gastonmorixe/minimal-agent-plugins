# ma-acp-plugin

Run minimal-agent as an [Agent Client Protocol](https://agentclientprotocol.com)
(ACP) agent over stdio. Editors (Zed, JetBrains, others) can then drive it with
no custom glue. The plugin is a `hostModes` entry. Start it with:

```sh
minimal-agent --host-mode acp
```

Level 1 scope: `initialize`, `session/new`, `session/prompt`, `session/cancel`,
`session/set_config_option` (provider, model, effort), text and thought streaming,
tool-call, usage and notice updates, and the ACP stop-reason map. One ACP
session per process. Zero runtime dependencies.

## Approval gate (`session/request_permission`)

minimal-agent runs long autonomous jobs. No person is assumed. So the approval
gate is **off by default**: the agent sends no `session/request_permission`,
and tools run.

### Turn it on

Add `--approval` after `--host-mode acp`:

```sh
minimal-agent --host-mode acp --approval
```

The operator sets it in the editor's agent command. It is a host-mode argument
(the args after `--host-mode acp` go to the plugin). The client cannot turn it
on or off over the wire in this version.

### Deadline

The gate waits 10 minutes for an answer by default. Set another deadline in
milliseconds with `--approval-timeout-ms` after `--host-mode acp`:

```sh
minimal-agent --host-mode acp --approval --approval-timeout-ms 30000
```

`--approval-timeout-ms=30000` also works. The value must be a positive integer
(1 to 2147483647). Any other value is a startup error: the agent writes
`acp: error: --approval-timeout-ms must be a positive integer ...` to stderr,
writes nothing to stdout, and exits with code 2. Without `--approval`, the
flag has no effect (the agent logs a warning).

### Which tools

When the gate is on, it asks before **every** tool call. The ACP spec v3
(section 8) names no tool subset. Mode and CLI permission denies run first, so
the gate never sees a tool that is already refused.

### Answers

The request offers four options. The option id is the ACP option kind.

| Option          | Effect                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `allow_once`    | Run this call.                                                                                       |
| `allow_always`  | Run this call. Do not ask again for this tool kind (`execute`, `edit`, `read`, ...) in this session. |
| `reject_once`   | Deny this call.                                                                                      |
| `reject_always` | Deny this call. Deny this tool kind from then on in this session, without a request.                 |

Remembered choices live in memory for the session only. Nothing is written to
disk. Kind `other` is the kind of every tool with no named kind (plugin and MCP
tools). For kind `other`, the gate remembers the choice per tool name, so
`allow_always` on one such tool does not allow the others.

The gate sends the `tool_call` update for a call before it asks about it.

### session/cancel

`session/cancel` denies the request that waits. Until the next
`session/prompt`, the gate also denies every later tool call at once, with no
request. So a client that does not answer cannot hold up the `cancelled`
reply.

### Failures deny only that tool call

Each of these denies the one tool call and nothing else:

- the request throws or rejects (a JSON-RPC error reply),
- stdin closes, or the host stops the channel,
- `session/cancel` while the request waits,
- outcome `cancelled`,
- an unknown option id, or a malformed answer,
- no answer within the gate's own deadline (10 minutes, or the
  `--approval-timeout-ms` value).

A denial is a tool error for the model, with a reason that starts with
`Tool call denied by the ACP approval gate`. The turn continues. A denial never
stops the run. The client sees a `tool_call_update` with status `failed`.

The gate is a `tool.willInvoke` chain hook (`permission-hook.ts`) that core
runs with `failClosed: true`. So a bug that makes the hook throw also denies
the call. Other `tool.willInvoke` hooks keep core's fail-open behavior.

### The gate hook did not load

Core skips a hook that fails to import or has no `hooks:tool.willInvoke`
grant. It logs the skip and goes on. Then no tool call can be asked about. With
`--approval`, the host mode finds this at `session/new` and writes a warning to
stderr. Each `session/prompt` then fails with a JSON-RPC error (`-32603`) that
says `the ACP approval gate failed to load`, before the model runs. So no tool
runs without approval. The process and the session stay open.

## Config options (provider, model, effort)

The order is `provider`, `model`, `effort`. Clients match an option by
`category`: `_provider`, `model`, and `thought_level`.

The `provider` option lists one row per provider and credential pair that has
a usable credential. It is sent only when the CLI has the target functions
(`listTargets`, `getTarget`, `setTarget`) and lists at least one row. The value
is the provider id, or `<providerId>:c-<10 hex>` when a credential is named.
The hex is the start of a sha256 of the credential name. The credential name
(often an email) is only in the label, because clients such as Zed save the
value in their settings. A provider change keeps the model when the new
provider has it, else it uses that provider's default model. The reply then
lists the new provider's models and recomputes effort. A credential that does
not resolve gives `-32602`, with nothing changed.

`session/set_config_option` returns the complete option list, with the new
value selected. The agent sends no `config_option_update` for this change. ACP
keeps that update for changes the agent makes itself (for example an automatic
model adoption). A set to the current value changes nothing. A new
model applies from the next model request. The next `usage_update` shows the
context window of the new model as `size`.

## Extension negotiation (`minimal-agent/ext`)

The agent advertises its ACP extensions in the `initialize` result, at
`agentCapabilities._meta["minimal-agent/ext"] = {"version": 1, "features": [...]}`.
The list is `usage`, plus `structuredOutput` and `sampling` only when the
CLI's core can apply them (`ctx.runtime.capabilities.outputSchema` and
`.temperature`, set by the CLI from feature detection). A CLI with no
`capabilities` object, or the pinned core ddc795e, gives `["usage"]`.
A client that speaks the extensions sends the same key in
`clientCapabilities._meta`. At `initialize` the agent computes the effective
set: the lower version and the intersection of the feature lists. A client
with no key, or with a malformed value, gets an empty set. Then the agent uses
only standard ACP. A plain client ignores the key, so nothing breaks.

The helper is `ext.ts` (`effectiveFeatures`). Unknown `_`-prefixed requests
get `-32601`. Unknown notifications are ignored. The full contract (naming,
hard rules, features, test vectors) is
[`docs/acp-extensions.md`](docs/acp-extensions.md).

## Structured output and sampling (L3, per prompt)

Read from `session/prompt` `_meta` only when the feature is in the effective
set. Else the key is ignored. A bad value is `-32602`.

- `structuredOutput`: `_meta["minimal-agent/outputSchema"]` = a JSON Schema
  object. The plugin passes it to `session.run` as `outputSchema`, then parses
  the final text as JSON (one Markdown fence is stripped) and checks it with a
  small validator (`structured-output.ts`: `type`, `properties`, `required`,
  `items`, `enum`, `const`, `additionalProperties: false`. Other keywords are
  ignored). Invalid: up to 2 retries in the same turn, each with a short user
  message that has the error. Usage of all runs is in the one reply. Valid:
  `_meta["minimal-agent/output"]` = the parsed value. Still invalid:
  `_meta["minimal-agent/outputError"] = {message}`. The `stopReason` is normal.
  Nesting deeper than 64 levels is a validation error. Each retry attempt
  streams its text with its own messageId (`<id>-attempt-<n>`, attempt 1
  unchanged), so read `minimal-agent/output`, not the joined text. A retry run
  that fails (for example a blocking `turn.willStart` hook) gives the first
  run's `stopReason` plus `outputError` `"retry <n> failed: <reason>"`.
- `sampling`: `_meta["minimal-agent/sampling"] = {"temperature": 0.2}`. Passed
  to `session.run` as `temperature`. No range check (the provider checks). When
  core reports `agent.temperature-ignored` (the model does not accept
  temperature), the client gets one `notice` per turn (or its text fallback).

Both options need core patches D1 and D4. On a CLI with an older core the
plugin does not advertise the features, so a client never sends them. A key
sent anyway is ignored (not in the effective set).

## Token usage

Two different things. Do not mix them.

- Context gauge: one `usage_update` per model round. `used` is that round's
  input + cache read + cache write tokens (the current context size, never a
  sum). `size` is the model's context window. No cost.
- Token totals: every `session/prompt` reply with a `stopReason` (also
  `cancelled`) carries the tokens of that prompt, summed over every model
  round. Never cumulative over the session. A cancelled prompt carries what
  was counted up to the cancel. The counters reset after each reply (also
  after an error reply).

The reply always has the standard `usage` (unstable ACP, best effort).
`inputTokens` is the full prompt size (uncached + cache read + cache write),
and `totalTokens` = `inputTokens + outputTokens`. When `usage` is in the
effective extension set, the reply also has `_meta["minimal-agent/usage"]`,
where `inputTokens` is uncached input and the cache tokens are apart:

```json
{
  "stopReason": "end_turn",
  "usage": {
    "totalTokens": 2285,
    "inputTokens": 2260,
    "outputTokens": 25,
    "cachedReadTokens": 2100,
    "cachedWriteTokens": 50
  },
  "_meta": {
    "minimal-agent/usage": {
      "inputTokens": 110,
      "outputTokens": 25,
      "cacheReadTokens": 2100,
      "cacheWriteTokens": 50
    }
  }
}
```

A cache field that no round reported is omitted (not reported, not zero).
`thoughtTokens` and `cost` are omitted: core does not report them. Exact
meaning: `docs/acp-extensions.md` section 5.a.

## session/new cwd

One process serves one cwd. `session/new` accepts a `cwd` that is the process
cwd or a symlink to it (on macOS, `/var/folders/...` is a symlink to
`/private/var/...`). Another dir is a JSON-RPC `-32602` error.

## session/new systemPrompt (ACP unstable)

The `initialize` result advertises
`agentCapabilities.sessionCapabilities.systemPrompt = { "mode": { "override": {} } }`
when the CLI's core supports both modes
(`ctx.runtime.capabilities.systemPrompt.append` and `.override`), or
`systemPrompt: {}` for append only. With no append support (a CLI with no
`capabilities` object, or the pinned core ddc795e, which drops the append
dep) there is no `systemPrompt` capability, and a `session/new` with
`systemPrompt` is `-32602`, so a client never thinks the instructions were
applied. A client can then send
`session/new { ..., "systemPrompt": { "mode": "append" | "override", "content": ContentBlock[] } }`.

- `append`: core adds the text as a section after the instructions.
- `override`: core replaces only the instructions section. Identity, the
  provider preamble and the session context stay (never a full replace).
- `content` accepts only `text` blocks. They are joined with a blank line.
  Any other block type (for example `image`) is `-32602`.
- A mode other than `append` or `override` is `-32602`. No session opens.
- No field, `null`, or empty text: the session opens with no system prompt
  option.

The plugin passes `{ systemPrompt: { mode, text } }` to
`HostRuntime.openSession(options)`. This needs a core with
`HostOpenSessionOptions` and the M2 append dep. On an older core the plugin
does not advertise the capability (see above). When the user config has a
`full` system prompt override, an ACP `override` has no effect, and the CLI
writes one warning to stderr.

## Tests

- `permission.test.ts`: the gate in process (answers, failures, deadline,
  cancel, per-name memory for kind `other`).
- `acp-host.e2e.test.ts`: spawns the real agent in ACP host mode against a
  local mock model. It needs the sibling `../minimal-agent-cli` checkout with
  its installed core, and skips with a printed reason without it. The model
  switch case loads the provider fixture `__fixtures__/two-models-provider`
  (two models with different context windows).

The `failClosed` hook flag needs core 1937784 or later. An older core rejects
the manifest key.
