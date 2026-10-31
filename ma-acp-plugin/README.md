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
disk. All tools with kind `other` share one remembered choice.

### Failures deny only that tool call

Each of these denies the one tool call and nothing else:

- the request throws or rejects (a JSON-RPC error reply),
- stdin closes, or the host stops the channel,
- `session/cancel` while the request waits,
- outcome `cancelled`,
- an unknown option id, or a malformed answer,
- no answer within the gate's own deadline (10 minutes).

A denial is a tool error for the model, with a reason that starts with
`Tool call denied by the ACP approval gate`. The turn continues. A denial never
stops the run. The client sees a `tool_call_update` with status `failed`.

The gate is a `tool.willInvoke` chain hook (`permission-hook.ts`) that core
runs with `failClosed: true`. So a bug that makes the hook throw also denies
the call. Other `tool.willInvoke` hooks keep core's fail-open behavior.

## Tests

- `permission.test.ts`: the gate in process (answers, failures, deadline).
- `acp-host.e2e.test.ts`: spawns the real agent in ACP host mode against a
  local mock model. It needs the sibling `../minimal-agent-cli` checkout with
  its installed core, and skips with a printed reason without it.

The `failClosed` hook flag needs core 1937784 or later. An older core rejects
the manifest key.
