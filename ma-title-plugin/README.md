# title plugin

The plugin makes a short title for a session, for example
`Session title plugin spec`. It sends the first prompt of the session one
time to a model of the session provider with a low cost. It saves the title
in the session index. `ma sessions` then shows the title with a `✦` mark.

The plugin is off by default.

## How it operates

1. The REPL sends the event `prompt.submitted` for each prompt.
2. The handler does a check of the prompt. It stops when one of these
   conditions is true:
   - The run mode is not on (see "Turn on the plugin").
   - The session has a title.
   - The prompt starts with `/`.
   - The prompt has fewer than 10 characters.
   - The user did not type the prompt (`source` is not `user`). An expanded
     command, a skill, a recovery retry and `/continue` make no title.
3. The handler sends one request and does not wait for it. The turn does not
   stop.
4. The handler does a check of the result. When the result is good, it writes
   one `kind: "title"` line to `~/.minimal-agent/sessions/index-meta.jsonl`.
5. When the request fails, the next prompt can try one more time. The
   maximum is 2 requests for each session in each process.

A title from the user is always more important. The plugin does not write an AI
title when a user title is in the index.

### Resume

A default `--resume` makes a fork with a new sid. The title line of the old
sid does not go to the new sid. Thus, the first good prompt after a resume
sends one new title request for the new sid. With `--resume-same-sid`, the
sid does not change, the plugin finds the title and sends no request.

## Turn on the plugin

Use one of these:

- Set `MINIMAL_AGENT_TITLE=1`. Then the plugin can operate in the run mode
  of this process.
- Add the run mode to `plugins.title.modes` in
  `~/.minimal-agent/config.jsonc`:

```jsonc
{ "plugins": { "title": { "modes": ["repl"] } } }
```

The plugin does not operate with `--dry-run`.

## Configuration

The plugin reads the block `plugins.title` in
`~/.minimal-agent/config.jsonc`.

| Key               | Type                            | Default | Rule                                                                                                                                   |
| ----------------- | ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | boolean                         | `true`  | `false` stops the plugin.                                                                                                              |
| `model`           | string                          | not set | A model id. It must be a model of the session provider. The provider must have a title profile.                                        |
| `modes`           | list                            | not set | The run modes where the plugin operates: `repl`, `one-shot`, `stream-json`, `host`, `subagent`. When it is not set, the plugin is off. |
| `subagents`       | `"off"`, `"derived"`, `"model"` | `"off"` | The rule for sub-agents (see "Sub-agents").                                                                                            |
| `effort`          | `"low"`, `"medium"`, `"high"`   | not set | The effort of the title request. When it is not set, the title profile of the provider gives the effort.                               |
| `maxUsdPerMTokIn` | number                          | `1.0`   | The maximum price in USD for each million input tokens.                                                                                |
| `timeoutMs`       | integer                         | `10000` | The time limit of the request, from 1000 to 30000.                                                                                     |
| `minChars`        | integer                         | `10`    | The minimum length of the prompt.                                                                                                      |

The plugin ignores an unknown key. A value of the wrong type gets the
default. The plugin writes a debug log line for each of these.

Environment variables:

- `MINIMAL_AGENT_TITLE=1`: turn on the plugin in the run mode of this process.
- `MINIMAL_AGENT_TITLE=0`: stop the plugin (the kill switch).
- `MINIMAL_AGENT_TITLE_MODEL=<id>`: the model id. It is used before
  `plugins.title.model`.

## The model

Titles operate for each provider. A provider plugin must give a title
profile (`recommendUtilityModel()`). The plugin reads it with
`host.models.utilityFor(<session provider>)`. The profile gives the model,
the effort, the structured output and the stream mode.

- When the session provider gives no title profile, the plugin makes no
  request. The `title.attempt` event has `stopReason: "no-model"`.
- The plugin does not use the model tags (`utility`, `haiku`) and does not
  use the session model.
- `MINIMAL_AGENT_TITLE_MODEL`, then `plugins.title.model`, can replace the
  profile model. The plugin accepts this model only when the provider has a
  title profile and the model is a model of the session provider. A model of
  a different provider stops the request (`stopReason: "other-provider"`).
  When this model has no structured output or its price is too high, the
  plugin uses the profile model.
- The effort comes from the profile. `plugins.title.effort` replaces it.
- The request has a limit of 256 output tokens.

Each model must have structured output and a known price that is not more
than `maxUsdPerMTokIn`. A price of 0 (a subscription or a local model) is
correct. When no model agrees with these rules, the plugin makes no title.

Providers:

| Provider  | Title profile                                                                                 |
| --------- | --------------------------------------------------------------------------------------------- |
| Anthropic | `claude-haiku-5-5` (alternative `claude-haiku-4-5-20251001`), effort `low`, no stream request |
| Other     | No title profile. No title.                                                                   |

When `claude-haiku-5-5` is not in the model list, the plugin uses
`claude-haiku-4-5-20251001`. Its price is $1.00 for each million input
tokens. This price is not more than the default `maxUsdPerMTokIn` of `1.0`,
thus the plugin accepts it. Then one title costs about 10 times more (about
$0.001). To stop this, set `maxUsdPerMTokIn` to `0.5`.

## Data that the plugin sends

- The plugin sends only the text of the first prompt that the user typed.
  It does not send an assistant text, a tool output or image data.
- It removes `<ma::…>` tags.
- When the text has more than 2000 characters, it sends the first 1500
  characters and the last 400 characters.
- It sends the text to the provider of the session, with the credentials of
  the session. Thus, the plugin adds no new third party.
- An override model of a different provider gets no request.

## Cost

On `claude-haiku-5-5` ($0.10 for each million input tokens, $0.50 for each
million output tokens), one title costs about $0.0001. Prices:
<https://docs.claude.com/en/docs/about-claude/pricing>.

The title cost is in the title line of the index (`usage`, `costUsd`). It is
not in `/usage` and not in the session cost of `ma sessions`. The detail view
of `ma sessions <sid>` shows it on a different line.

## Stop the plugin

Use one of these:

- `MINIMAL_AGENT_TITLE=0`
- `--disable-plugin title`
- `MINIMAL_AGENT_DISABLE_PLUGINS=title`
- `"plugins": { "title": { "enabled": false } }`

## Sub-agents

With the default `subagents: "off"`, a sub-agent makes no title. This is
also true when the sub-agent gets `MINIMAL_AGENT_TITLE=1` from its lead.
With `"derived"`, the plugin makes no request.

## Errors and diagnostics

The plugin does not show errors. It writes them to the debug log only.

For each request, the plugin sends one `title.attempt` event on the plugin
event bus. The event has these fields: `sid`, `purpose`, `model`,
`provider`, `latencyMs`, `stopReason`, `inputTokens`, `outputTokens`,
`costUsd` and `written`. When the plugin finds no model, `stopReason` is
`no-model`, `over-ceiling` or `other-provider`. When the request has an
error, `stopReason` is `exception`. When the index write has an error,
`stopReason` is `write-failed`.

## Files

- `manifest.json`: the event `prompt.submitted` with `"host": true`, and the
  capabilities `llm:complete`, `sessions:meta`, `models:read`.
- `handlers/on_prompt_submitted.ts`: the handler.
- `lib/`: the configuration, the prompt checks, the input limit, the title
  checks and the model selection.
- `prompts/system.md`: the system prompt of the title request.
- `e2e/title.e2e.ts`: one request to the provider. It operates only with
  `E2E=1` and `MA_E2E_CREDENTIAL_NAME=<credential-name>`.
