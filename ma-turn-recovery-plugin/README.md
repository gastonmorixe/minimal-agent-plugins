# ma-turn-recovery-plugin

The plugin id is `turn-recovery`. Owns the model-facing text of 4 synthetic tool results. Core asks this plugin
through the manifest key `syntheticText`.

## Kinds and facts

- `tool_result.handler_error`: facts `{detail: string}`. Text: `Handler error: <detail>`.
- `tool_result.interrupted_by_stop`: facts `{}`.
- `tool_result.aborted`: facts `{site: "orphan" | "runtime"}`. Two sites, two texts.
- `tool_result.policy_denied`: facts `{hook: string}`. Only `tool.willInvoke` has text today.

An unknown `site`, an unknown `hook`, a missing `detail` or a kind this plugin
does not own throws an Error. The core resolver catches it, uses its own text
and records a diagnostic.

`detail` is a plain string fact (the foreign handler message) until S11.2.

Core still holds the same texts as a warn-mode fallback until S3.3. Removing
this plugin changes nothing visible.

Tests pin the text bytes.

## Status

Today core asks this plugin for `tool_result.handler_error` only. The other three kinds (`interrupted_by_stop`, `aborted`, `policy_denied`) answer the same way when asked. Core will ask for them in the next core commits. Until then core uses its own text for those three, so nothing changes visibly.
