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
- Only `text` blocks and string content of `user` messages expand. A
  `tool_result` block does not. A block with a harness mark (`block.sideband`
  set, for example the compaction checkpoint) does not, so a ref that the
  model wrote into a summary stays a ref.
- When the context window of the send model is known (`models:read`), a
  paste with more estimated tokens (bytes / 4) than half of the window does
  not expand. The ref stays, with one `paste.too-large` warning for each
  (sid, id). When the window is not known, there is no limit.
- The rendered form of each (sid, id) stays in a bounded LRU cache (64 MB
  and 256 entries; the oldest goes first). The files are immutable, so the
  cache has no invalidation, and a send does not read each past paste again.
- `neutralize` changes only the sideband sigil. Tags that are not sideband
  tags (for example a `<system>` tag in the paste) go to the model raw, on
  purpose: the paste is user text, and the `paste` block marks it as
  untrusted.
- With no codec, a paste goes in as literal text.

Config (`~/.minimal-agent/config.jsonc`):

```jsonc
{
  "plugins": {
    "paste": {
      "collapse": { "minLines": 4, "minBytes": 1200, "floorBytes": 120 },
      "lineNumbers": true
    }
  }
}
```

The values above are the defaults. A paste becomes a ref when it has
`minLines` lines or more, or `minBytes` bytes or more. A paste below
`floorBytes` stays literal text, so 4 very short lines (a short list, a few
commands) do not become a ref. A limit of 0 is off. `0/0/0` makes a ref for
each non-empty paste.

`lineNumbers` (default true): the model gets the paste body with a line
number (from 1) and a TAB before each line (`N<TAB>line`), and the block has
`numbered="true"`. A final LF gets no number. The stored file and the `bytes`
attr stay the exact paste. The too-large check uses the size of the numbered
body. Each send reads this option, so a change has effect on the next send.

The text hook and the chip need CLI support (`ctx.paste`, `ctx.chips`). The
CLI gives `ctx.paste` only to a plugin whose manifest `permissions` has
`ui:paste`, because a paste hook reads all pasted text. With
an older CLI, `ui/setup.ts` does nothing, but refs that exist still expand.

## What the model sees

The model gets each paste as one `paste` block of the codec. The ref in the
stored message is self-closing; on the wire it becomes the full block with
the `id`, `bytes`, `lines` and `numbered` attrs, and the body is the paste
text. The tag describes itself. The codec makes the tag syntax, so this
README does not show it. For a paste of 40 lines and 1.5 kB, the block has
`id`, `bytes="1500"`, `lines="40"` and `numbered="true"`. Its body starts
with `1<TAB>` and the first line, and ends with `40<TAB>` and the last line.

A paste below the collapse limits goes in as literal text, with no tag.

The plugin sends NO system prompt text about pastes, on purpose: a prompt
block costs tokens on every request, also when the conversation has no
paste.
