# ma-paste-plugin

Text paste refs on the sideband codec (manifest id `paste`).

- The terminal saves each text paste at once to
  `<sessionsDir>/<sid>.files/paste/<id>.txt` (core capability
  `sessions:files`). The editor holds a short self-closing `paste` ref, and
  shows it as a chip: `[Paste #u194m 130B 129L]`.
- The queue, the history and the session JSONL hold the ref only.
- The `message.willSend` hook (priority 100) replaces each known ref with the
  file content in a `paste` block, on each send and on each host. The body
  goes through `neutralize`. An unknown id stays as the ref, with one
  `paste.missing` warning.
- With no codec, a paste goes in as literal text.

Config (`~/.minimal-agent/config.jsonc`):

```jsonc
{ "plugins": { "paste": { "collapse": { "minLines": 0, "minBytes": 0 } } } }
```

`0/0` (the default) makes a ref for each non-empty paste. Otherwise a paste
becomes a ref when it reaches one of the two limits.

The text hook and the chip need CLI support (`ctx.paste`, `ctx.chips`). With
an older CLI, `ui/setup.ts` does nothing, but refs that exist still expand.
