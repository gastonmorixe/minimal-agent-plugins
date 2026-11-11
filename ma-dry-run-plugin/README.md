# dry-run plugin

Builds the full LLM request, prints it as JSON, and blocks the send. No
request reaches the provider.

The dump shows what the model would get: every system block (including
plugin fragments such as the env-info snapshot), the messages, the tool
definitions, and the request options (max tokens, thinking, effort,
temperature).

## Use

```bash
minimal-agent -p "say hi" --enable-plugin dry-run > request.json
MINIMAL_AGENT_DRY_RUN_OUT=request.json minimal-agent -p "say hi" --enable-plugin dry-run
```

The plugin is disabled by default. `--enable-plugin dry-run` turns it on for
one run.

| Variable                    | Effect                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| `MINIMAL_AGENT_DRY_RUN_OUT` | Write the JSON to this file. Unset or `-`: stdout. `stderr`: stderr |

The CLI `--dry-run` flag sets `MINIMAL_AGENT_DRY_RUN_OUT=stderr` on the
JSON output formats (`json`, `stream-json`, `open-responses`) when the
variable is unset, so stdout stays valid JSON.

The run exits non-zero with `dry-run: request built and printed, not sent`.
That is the expected result: the send was blocked on purpose.

## How it works

One `message.willSend` chain hook (`handlers/dump_and_halt.ts`) at priority
0, the lowest the loader allows. Listeners run high to low, so this one sees
the payload after every other listener (for example a redaction hook).

- Conversation sends: write the dump, then halt.
- Compaction, title and quota sends: halt with no dump.

## Limits

- The dump is the canonical request, not the provider wire JSON. Header and
  body mapping in the provider adapter does not run.
- Auth runs at startup before any send. The selected provider still needs a
  stored credential.
- `request` (tools and options) needs a core that fills
  `SendSnapshot.request`. An older core gives `request: null`.

## Files

- `manifest.json`: the hook subscription and the `hooks:message.willSend`
  permission.
- `handlers/dump_and_halt.ts`: the handler.
- `handlers/dump_and_halt.test.ts`: unit tests.
