# ma-acp-plugin

Run minimal-agent as an [Agent Client Protocol](https://agentclientprotocol.com)
(ACP) agent over stdio. Editors (Zed, JetBrains, others) can then drive it with
no custom glue. The plugin is a `hostModes` entry. Start it with:

```sh
minimal-agent --host-mode acp
```

Level 1 scope: `initialize`, `session/new`, `session/prompt`, `session/cancel`,
`session/set_config_option` (model, effort), text and thought streaming,
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

| Option | Effect |
|---|---|
| `allow_once` | Run this call. |
| `allow_always` | Run this call. Do not ask again for this tool kind (`execute`, `edit`, `read`, ...) in this session. |
| `reject_once` | Deny this call. |
| `reject_always` | Deny this call. Deny this tool kind from then on in this session, without a request. |

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

## Config options (model, effort)

`session/set_config_option` returns the complete option list. When the set
changes state, the agent also sends a `config_option_update` with the same
list. A set to the current value changes nothing and sends no update. A new
model applies from the next model request. The next `usage_update` shows the
context window of the new model as `size`.

## session/new cwd

One process serves one cwd. `session/new` accepts a `cwd` that is the process
cwd or a symlink to it (on macOS, `/var/folders/...` is a symlink to
`/private/var/...`). Another dir is a JSON-RPC `-32602` error.

## Tests

- `permission.test.ts`: the gate in process (answers, failures, deadline,
  cancel, per-name memory for kind `other`).
- `acp-host.e2e.test.ts`: spawns the real agent in ACP host mode against a
  local mock model. It needs the sibling `../minimal-agent-cli` checkout with
  its installed core, and skips with a printed reason without it. The model
  switch case loads the provider fixture `__fixtures__/two-models-provider`
  (two models with different context windows).

The `failClosed` hook flag needs core 5b7342c or later. An older core rejects
the manifest key.
