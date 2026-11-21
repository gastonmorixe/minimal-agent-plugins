# title plugin

The plugin makes a short title for a session, for example
`Session title plugin spec`. It sends the first prompt of the session one
time to a model of the session provider with a low cost. It saves the title
in the session index. `ma sessions` then shows the title with a `✦` mark.

The plugin is on by default in the interactive REPL only. It is off by
default in the one-shot, stream-json and host modes. It is always off in a
sub-agent. To stop it, set `MINIMAL_AGENT_TITLE=0` or
`"plugins": { "title": { "enabled": false } }` (see "Stop the plugin").

## How it operates

1. The REPL sends the event `prompt.submitted` for each prompt.
2. The handler does a check of the prompt. It stops when one of these
   conditions is true:
   - The run mode is not on (see "Run modes").
   - The session has a title.
   - The prompt starts with `/` (see "Slash commands").
   - The prompt has fewer than 10 characters.
   - The user did not type the prompt (`source` is not `user`). An expanded
     command, a skill, a recovery retry, `/continue` and an injected prompt
     (`inject`: an intercom, background-job, sub-agent, cron or cloud wake)
     make no title.
3. The handler keeps the text of the first good prompt of the session. Each
   request sends this text, also a retry after a later prompt.
4. When the session is a fork, and the parent session has a title, the
   handler copies that title (see "Resume"). It sends no request.
5. Else the handler sends one request and does not wait for it. The turn does
   not stop.
6. The handler does a check of the result. When the result is good, it writes
   one `kind: "title"` line to `~/.minimal-agent/sessions/index-meta.jsonl`.
7. When the request fails, the next prompt can try one more time. The
   maximum is 2 requests for each session in each process. When the plugin
   finds no model (`no-model`, `over-ceiling`), it sends no request, and this
   does not count as one of the 2 requests. The next prompt tries again.

### Slash commands

A line `/name args` gives the args as the title text, when the args have 10
characters or more. The name has only letters, digits, `-`, `_` and `:`.
For example, `/plan fix the session title bugs` gives the text
`fix the session title bugs`. Each other line that starts with `/` makes no
title: a command with no args or with short args, and a path such as
`/usr/bin/env`. The expanded text of the same command has the source
`expand`, thus it makes no title.

A title from the user is always more important. The plugin does not write an AI
title when a user title is in the index.

### Resume

A default `--resume` makes a fork with a new sid. The new sid has no title
line. On the first good prompt, the plugin reads the parent sid
(`sessions.meta(sid).parentSid`). When the parent has a title, the plugin
writes the same title for the new sid (source `ai`, with no model and no
usage). It sends no request, and it sends one `title.saved` event. When the
parent has no title, or the read fails, the plugin sends a request as usual.
It does this check one time for each sid. With `--resume-same-sid`, the sid
does not change, the plugin finds the title and sends no request.

## Run modes

When you set nothing, the plugin operates only in the interactive REPL
(`repl` with a TTY). It does not operate in the one-shot, stream-json and
host modes, and it does not operate in a sub-agent.

To turn on the plugin in a different mode, use one of these:

- Set `MINIMAL_AGENT_TITLE=1`. Then the plugin can operate in the run mode
  of this process (not in a sub-agent).
- Set the run modes in `plugins.title.modes` in
  `~/.minimal-agent/config.jsonc`. This list replaces the default. For
  example, this list turns on one-shot and the REPL:

```jsonc
{ "plugins": { "title": { "modes": ["repl", "one-shot"] } } }
```

An empty list (`"modes": []`) turns off the plugin in all modes.

The plugin does not operate with `--dry-run`.

## Configuration

The plugin reads the block `plugins.title` in
`~/.minimal-agent/config.jsonc`.

| Key               | Type                            | Default | Rule                                                                                                                                  |
| ----------------- | ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | boolean                         | `true`  | `false` stops the plugin.                                                                                                             |
| `model`           | string                          | not set | A model id. It must be a model of the session provider. The provider must have a title profile.                                       |
| `modes`           | list                            | not set | The run modes where the plugin operates: `repl`, `one-shot`, `stream-json`, `host`, `subagent`. When it is not set: `repl` only.      |
| `subagents`       | `"off"`, `"derived"`, `"model"` | `"off"` | The rule for sub-agents (see "Sub-agents").                                                                                           |
| `effort`          | `"low"`, `"medium"`, `"high"`   | not set | The effort of the title request. When it is not set, the title profile of the provider gives the effort.                              |
| `maxUsdPerMTokIn` | number                          | `1.0`   | The maximum price in USD for each million input tokens.                                                                               |
| `timeoutMs`       | integer                         | `10000` | The time limit of the request, from 1000 to 30000.                                                                                    |
| `minChars`        | integer                         | `10`    | The minimum length of the prompt.                                                                                                     |
| `language`        | string                          | not set | A language name for the title, for example `Spanish`: letters, spaces and hyphens, 40 characters maximum. Else the plugin ignores it. |

The plugin ignores an unknown key. A value of the wrong type gets the
default. The plugin writes a debug log line for each of these.

Environment variables:

- `MINIMAL_AGENT_TITLE=1`: turn on the plugin in the run mode of this process
  (not in a sub-agent).
- `MINIMAL_AGENT_TITLE=0`: stop the plugin in all modes (the kill switch).
- `MINIMAL_AGENT_TITLE_MODEL=<id>`: the model id. It is used before
  `plugins.title.model`.
- `MINIMAL_AGENT_TITLE_LANGUAGE=<name>`: the title language. It is used
  before `plugins.title.language`. The plugin ignores a bad value.

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
| OpenAI    | `gpt-6-luna`, effort `low`, streaming Responses API                                           |
| Other     | No title profile. No title.                                                                   |

When `claude-haiku-5-5` is not in the model list, the plugin uses
`claude-haiku-4-5-20251001`. Its price is $1.00 for each million input
tokens. This price is not more than the default `maxUsdPerMTokIn` of `1.0`,
thus the plugin accepts it. Then one title costs about 10 times more (about
$0.001). To stop this, set `maxUsdPerMTokIn` to `0.5`.

## Data that the plugin sends

- The plugin sends only the text of the first prompt that the user typed.
  It does not send an assistant text, a tool output or image data.
- It removes the internal tags with the session codec (`ctx.sideband`).
  With no codec (an old host), the plugin makes no title.
- The request has the same layout as Claude Code. The system prompt has the
  rules (`prompts/system.md`). The user message is the text in a
  `<session>` block, then one language line:

  ```text
  <session>
  what are the latest news?
  </session>

  Write the title in the main language of the text in <session>. One word or code name in another language does not change it. The language of these instructions does not change it.
  ```

  With a language (`plugins.title.language` or
  `MINIMAL_AGENT_TITLE_LANGUAGE`), the last line is: `Write the title in
  Spanish. Keep technical terms and code names as they are.`
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

The plugin is on by default in the interactive REPL. To stop it, use one of
these:

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
event bus. When the plugin finds no model, it sends one event and one debug
line for each session, not one for each prompt. The event has these fields: `sid`, `purpose`, `model`,
`provider`, `latencyMs`, `stopReason`, `inputTokens`, `outputTokens`,
`costUsd` and `written`. When the plugin finds no model, `stopReason` is
`no-model`, `over-ceiling` or `other-provider`. When the request has an
error, `stopReason` is `exception`. When the index write has an error,
`stopReason` is `write-failed`.

## The `title.saved` event

After the plugin wrote a title, it sends one `title.saved` event on the same
bus. The event has the fields `sid`, `title` and `source` (always `ai`). It is
a signal to refresh a screen. The plugin sends it after the write, and only
when it wrote a title. An error in the emit does not change the result of the
write.

A live-area slot that names `title.saved` in `refreshOn` runs at once. The
`intercom_beat` slot of `ma-intercom-plugin` does this, so the footer shows the
new title with no wait for the next timer tick. The event is a hint, not the
source of truth: a slot reads the title with `sessions.title(sid)`. A resumed
session has a title but sends no event, so a slot must keep its timer.

## Files

- `manifest.json`: the event `prompt.submitted` with `"host": true`, and the
  capabilities `llm:complete`, `sessions:meta`, `sessions:read` (the parent
  title of a fork), `models:read`.
- `handlers/on_prompt_submitted.ts`: the handler.
- `lib/`: the configuration, the prompt checks, the input limit, the title
  checks and the model selection.
- `prompts/system.md`: the system prompt of the title request.
- `e2e/title.e2e.ts`: one request to the provider. It operates only with
  `E2E=1` and `MA_E2E_CREDENTIAL_NAME=<credential-name>`.
