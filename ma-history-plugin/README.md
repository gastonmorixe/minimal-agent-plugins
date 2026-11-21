# History

Persistent ↑/↓ recall for the prompt editor (`❯ `). Submitted prompts are appended to two newline-delimited JSON files and recalled via arrow keys.

History holds only what the user TYPED. The plugin subscribes to `editor.submitted` (permission `hooks:editor.submitted`): the host emits it once for each non-blank line that the user submits in the editor, with the raw text, before slash-command dispatch (so `/model x` is recorded as typed). It does NOT subscribe to `prompt.submitted`, which is a queue event for any origin: injected prompts (intercom, sub-agents, schedule, background jobs), expanded commands and skills, recovery retries and `/continue` never land in history. Headless (`-p`) prompts are not recorded.

**Requires** a host that emits `editor.submitted`: the release after core 2c02521c / cli a044c77. On an older host the plugin records nothing and shows no warning (the manifest has no min-host-version field).

This is a UX layer for the human user. **No model-facing surface, no tools, no inline tags, no PROMPT.md** the loader treats this plugin assilent in the system prompt.

## Key bindings

- **↑ on an empty-or-recalled buffer** when the cursor sits on the FIRST visual row recalls the previous submitted prompt.
- **↓ on the LAST visual row** of a recalled buffer walks toward newer entries. Overshoot past the newest entry restores the user's pre-recall draft.
- **Ctrl+R** is reserved for a future incremental reverse-search modal. For now it's a silent no-op.

## Storage

Per-user, never in the project tree, never committed:

- `~/.minimal-agent/projects/<absolute-cwd>/history.jsonl`: primary recall index for the current project.
- `~/.minimal-agent/history.jsonl`: global mirror, useful for future cross-project search.

Each entry is a single JSON line:

```json
{ "id": "...", "ts": 1700000000000, "sid": "...", "cwd": "/abs/path", "text": "...", "exit": 0 }
```

Stable wire format, append-only, never rewrite an existing line.

## CLI

Inspect / manage outside the agent:

```sh
bun run ma-history-plugin/cli.ts list           # newest-first
bun run ma-history-plugin/cli.ts search <query> # case-insensitive substring
bun run ma-history-plugin/cli.ts path           # show the resolved file
bun run ma-history-plugin/cli.ts clear          # wipe (with confirm)
bun run ma-history-plugin/cli.ts export         # print every entry as JSON lines
```

## Disabling

- `MINIMAL_AGENT_NO_HISTORY=1` for one-off invocations.
- `plugins.history.enabled = false` in `~/.minimal-agent/config.jsonc` to turn it off permanently.
