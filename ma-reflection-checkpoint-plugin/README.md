# reflection-checkpoint plugin

This plugin adds a soft reflection checkpoint to long tool loops. The
feature was in core before. Now it is in this plugin.

By default, the plugin is off (`"enabled": false` in `manifest.json`). To
enable it, set this value in `~/.minimal-agent/config.jsonc`:

```jsonc
{
  "plugins": {
    "reflection-checkpoint": {
      "enabled": true,
      "interval": 50, // tool rounds between two checkpoints. 0 = off.
      "cooldownMs": 60000 // wait before the checkpoint. 0 = no wait.
    }
  }
}
```

## How it operates

1. After each tool round, core sends the `tool.didBatch` hook with `round`
   (1 is the first round of the run).
2. When `round` is a multiple of `interval`, the plugin waits `cooldownMs`
   through `ctx.countdown`. The terminal shows
   `reflection @ round N · Ns remaining · press Esc to skip`. Esc stops the
   wait, and the run continues. An abort of the turn stops the wait, and
   the plugin adds no text. The plugin waits only in an interactive run
   (`ctx.run.interactive`). In a run that is not interactive (one-shot,
   stream-json, host mode, sub-agent), it does not wait, and `S` is 0.
3. The plugin returns the checkpoint text as `additionalContext`. Core adds
   it to the user content of the next model request:
   `<ma::agent::reflection-checkpoint round="N" cooldown-applied-seconds="S" />`
   and the reflection prompt (continue, change the method, or speak to the
   user). `S` is the time that the plugin waited.
4. The plugin adds no system prompt section. The checkpoint text gives
   the 3 choices and the ack syntax. The plugin reads the config one time
   for each process.

## The ack

The model can write this tag in its response text:

```text
<ma::emit::reflection-ack silence-for="K" reason="..." />
```

The core scanner removes the tag from the visible output and sends its
attributes to `handlers/ack.ts`. The handler sets the silence count of the
session to K. The next K due checkpoints get no wait and no text. In place
of the tag, the user sees one dim line:
`reflection ack: skip the next K reflection checkpoints (reason)`.

- No `silence-for`: K is 1.
- `silence-for="0"` or a bad value: no change.
- A new run sets the count to 0, but an ack in the first response of the
  new run stays. An ack in the last response of a run does not go into the
  next run. The `turn.didEnd` / `turn.aborted` listener clears the count at
  the end of each run. If the host sends no such event, a `round` that goes
  down (a new run) clears the count.

The plugin keeps the count for each session id (at most 256 sessions, LRU).
The run-end listener deletes the entry of the session. Core keeps no
reflection state.

## Config

Sources, the last one wins:

1. The defaults: `interval` 50, `cooldownMs` 60000.
2. `plugins["reflection-checkpoint"].interval` and `.cooldownMs` in the
   config file (`MINIMAL_AGENT_CONFIG`, else
   `<agent-home>/config.jsonc`, else `<agent-home>/config.json`).
3. The env vars `MINIMAL_AGENT_REFLECTION_INTERVAL` and
   `MINIMAL_AGENT_REFLECTION_COOLDOWN_MS`.

The plugin ignores a value that is not a number of 0 or more.

## Files

| File                         | Contents                                       |
| ---------------------------- | ---------------------------------------------- |
| `manifest.json`              | The hooks and the inline tag.                  |
| `handlers/did-batch.ts`      | The `tool.didBatch` listener (the checkpoint). |
| `handlers/ack.ts`            | The `reflection-ack` inline-tag handler.       |
| `handlers/run-end.ts`        | The run-end listener (clears the count).       |
| `lib/config.ts`              | The config reader.                             |
| `lib/state.ts`               | The silence count for each session.            |
| `lib/text.ts`                | The text from `prompts/attachment.tmpl.md`.    |
| `prompts/attachment.tmpl.md` | The model-facing text.                         |
| `reflection.test.ts`         | The unit tests.                                |
| `loader.integration.test.ts` | The test through the real core `PluginLoader`. |
