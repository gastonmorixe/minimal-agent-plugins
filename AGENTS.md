Orientation for agents working in this **plugins** repository. User-facing
overview lives in [`README.md`](README.md); the change log is
[`CHANGELOG.md`](CHANGELOG.md).

This tree is first-party `ma-*-plugin` packages for
[minimal-agent-core](https://github.com/gastonmorixe/minimal-agent-core). Core
harness code lives in the sibling core remote, not here.

## Build, test, lint

- `bun run check` is the gate that must stay green (typecheck, oxlint, format,
  biome, tests).
- `bun test` runs the whole-tree suite; `bun run test:plugins` fans out
  `bun --filter 'ma-*' test` in parallel.
- This is a Bun workspace: every `ma-*-plugin` package is a workspace member.
  Toolchain versions live under `workspaces.catalog`.

## Git commits (co-author trailer)

Every commit made by an agent must include a `Co-authored-by` trailer for the
**current session** (name + short session id):

```
Co-authored-by: {Name} <{short-sid}@minimal-agent>
```

- `{Name}` — session name (from `SessionInfo` / the TUI, e.g. `Veronica`)
- `{short-sid}` — first 8 hex characters of the session id (e.g. `a26a1e75`
  from `a26a1e75-…`)

Example:

```
Co-authored-by: Veronica <a26a1e75@minimal-agent>
```

Put the trailer on its own line at the end of the commit message (blank line
before it, HEREDOC so the trailer is preserved).
