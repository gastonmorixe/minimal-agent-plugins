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
7. When the request fails, the plugin puts the error in one of two classes
   (see "Retry policy"). After a final error, the next prompt can try one
   more time. The maximum is 2 final errors for each session in each
   process. After a transient error, the plugin tries again after a wait,
   with no limit. When the plugin finds no model (`no-model`,
   `over-ceiling`), it sends no request, and this does not count as one of
   the 2 requests. The next prompt tries again.

### Retry policy

The agent can run for a long time. Thus a network problem must not stop the
title for the full process. The plugin puts each failed request in one of
two classes:

1. Transient: the provider or the network did not give an answer. Examples:
   a timeout, an abort of the request, a connection reset, a DNS error, an
   HTTP 408, 429 or 5xx status, an overloaded provider, a rate limit, a
   stream with no activity. A transient error does not count as one of the
   2 requests. The plugin waits, then the next prompt after the wait sends
   the request again. The wait is 1, 2, 5, 15 and 30 minutes, then 60
   minutes for each later transient error in a row. There is no limit.
2. Final: the model gave a result that the plugin cannot use, or the write
   failed. Examples: invalid JSON, a title that is not usable, the stop
   reasons `max_tokens`, `refusal` and `content_filter`, a quota or billing
   error, an HTTP 400, 401 or 403 status, and an index write error
   (`not-owned`, `no-session-file`). A final error counts as one of the 2
   requests.

An error that the plugin does not know is final. Thus a new error kind
cannot make requests with no limit.

The plugin has no timer. A retry starts only on a prompt. A prompt during
the wait sends no request, and the debug log shows `backoff`. Each retry
sends the text of the first good prompt. A final error ends the row of
transient errors, so the next transient error waits 1 minute again. A
title resets the count.

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
- A paste ref (a large paste that `ma-paste-plugin` keeps in a session file)
  becomes the text of its file, before the plugin removes the other tags. The
  plugin reads `<sessionsDir>/<sid>.files/paste/<id>.txt` with the `paths`
  capability. It sends a maximum of 600 characters of each paste, then the
  marker `(rest of the pasted text omitted)`. The id must have 5 characters
  from `[0-9a-z]`, the sid must have no `/`, no `\` and no `..`, and the
  path must stay in the paste folder of the sid. When a check fails, or the
  file is missing, the ref becomes the marker `(pasted text)`. The plugin
  reads only a regular file: a symlink, a folder or a FIFO gives the marker.
  The length checks do not count the marker, so a prompt that is only a ref
  with no file makes no title.
- It removes each saved prompt token (`&name`, see `ma-prompts-plugin`). A
  token points to a template of instructions that the user uses again. It is
  not the subject of the session. The plugin removes the tokens before it
  puts the paste text in, so an `&word` in a paste stays.
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

When a request fails, the event also has the field `retry`: `transient` or
`final` (see "Retry policy"). The debug line of the failure shows the class
and the next try, for example
`retry=transient n=2 next=2026-11-23T10:03:00.000Z` or
`retry=final attempts=1/2 next=next-prompt`.

## The `SessionTitle` tool

The plugin gives the model one tool, `SessionTitle`. The model calls it
only when the user asks to set or change the title, or when the subject of
the session changed a lot. It does not call it to read the title.

The input has two optional fields:

1. `title`: the new title. With it, the tool writes this title and sends no
   request.
2. `lock`: `true` writes a `user` title. An automatic title does not replace
   a `user` title. The default is `false`, which writes an `ai` title.
   `lock: true` needs a `title`. Without it, the tool gives an error.

With `title`, the tool operates in all run modes, also when the plugin is
off.

Without `title`, the tool makes a new title with the same model, request and
checks as the automatic path. It sends the first user message and the last 3
user messages of the session, with the same clean steps (paste refs, `&name`
tokens, internal tags). It does not stop when a title exists. This path
makes a request, so it gives an error and sends no request when the plugin is
off (`plugins.title.enabled: false` or `MINIMAL_AGENT_TITLE=0`).

Without `title`, the tool makes a maximum of one request in 10 minutes for
each session (`REGENERATE_COOLDOWN_MS`). The time starts when the request
starts, so a failed request also counts. A call in that time sends no request.
It gives an error with the title and tells the model to give `title`. A call
with `title` has no limit. The plugin keeps the time in memory only, so a new
process starts with no time.

The first part is the first prompt that the automatic handler kept, when it
has one. The session messages hold the full body of each saved prompt
(`ma-prompts-plugin` puts the body in place of `&name` before the turn). Thus
the tool reads the prompt library (`<agent home>/prompts/*.md` and
`<cwd>/.agents/prompts/*.md`, read only, a maximum of 500 files of 64 KB) and
removes each body from the message text.

With `lock: false` and a `user` title, the tool writes nothing. Core does
not let an `ai` title replace a `user` title. The tool result tells the model
this.

Before the write, the tool marks the session as done for the automatic
handler. Thus the handler makes no more requests for that session in this
process, and it drops a result that comes during the write. After a write,
the tool sends `title.saved`. The result is
`Title: <title> (source: ai)` or `(source: user)`, with the title that core
saved (core removes tags and keeps a maximum of 80 characters).

A tool context has no `emit`. The tool sends `title.saved` with the bus
`emit` of the last `prompt.submitted` call (`lib/shared.ts`). Before the
first prompt, the tool sends no event, and the footer shows the title at its
next timer tick.

## The `title.saved` event

After the plugin wrote a title, it sends one `title.saved` event on the same
bus. The event has the fields `sid`, `title` and `source` (`ai`, or `user` for
a title that the tool locked). It is
a signal to refresh a screen. The plugin sends it after the write, and only
when it wrote a title. An error in the emit does not change the result of the
write.

A live-area slot that names `title.saved` in `refreshOn` runs at once. The
`intercom_beat` slot of `ma-intercom-plugin` does this, so the footer shows the
new title with no wait for the next timer tick. The event is a hint, not the
source of truth: a slot reads the title with `sessions.title(sid)`. A resumed
session has a title but sends no event, so a slot must keep its timer.

## Files

- `manifest.json`: the event `prompt.submitted` with `"host": true`, the
  tool `SessionTitle`, and the capabilities `llm:complete`, `sessions:meta`,
  `sessions:read` (the parent title of a fork, the messages for the tool),
  `models:read` and `paths` (the paste files).
- `handlers/on_prompt_submitted.ts`: the automatic handler.
- `handlers/session_title_tool.ts`: the `SessionTitle` tool.
- `lib/`: the configuration, the prompt checks, the input limit, the paste
  refs (`paste.ts`), the saved prompt bodies (`prompt-library.ts`), the
  title request (`generate.ts`), the state that the
  handler and the tool share (`shared.ts`), the title checks and the model
  selection.
- `prompts/system.md`: the system prompt of the title request.
- `e2e/title.e2e.ts`: one request to the provider. It operates only with
  `E2E=1` and `MA_E2E_CREDENTIAL_NAME=<credential-name>`.
