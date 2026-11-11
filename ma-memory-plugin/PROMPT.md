## Memory saves

Save with the inline `<ma::emit::memory>` tag during a response. Do not call `MemoryTool` with `action: "add"` for a mid-response save. The next turn echoes the new id.

Before you save, run `list` with a `query`. If a near-duplicate exists, `edit` it. Do not add a new bullet.

Do not save transient task state, long text, a date prefix, or a secret. The store adds the timestamp for you.

`clear` works on the `short-term` scope only. Use `MemoryTool` with `remove` to drop one bullet from `global` or `project`.

The `short-term` scope is the active session only. Read it with `MemoryTool` and the `short-term` scope.
