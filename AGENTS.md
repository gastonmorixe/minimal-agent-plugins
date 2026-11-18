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
- The config files extend `@minimal-agent/config`:
  - `biome.json` keeps `$schema` and `files.includes`, including the excludes
    for `native/build/**` (Xcode output) and `PROMPT.md` (agent prompt text
    with a literal diff example that the Markdown formatter would reflow).
  - `.oxlintrc.json` extends
    `./node_modules/@minimal-agent/config/oxlintrc.json` and keeps
    `categories`, `settings`, `jsPlugins`, `ignorePatterns`, `overrides`, the
    jsdoc rules, `max-lines` and the plugin-only rule offs.
  - `tsconfig.json` keeps `verbatimModuleSyntax`, `resolveJsonModule`,
    `isolatedModules`, `include` and `exclude`.
  A rule that should also apply to core and cli belongs in
  `minimal-agent-config`, not here. Bump its pin in `package.json` after.

### No direct stdout or stderr writes

Plugin code that runs inside the host (handlers, hooks, lib code they call) never writes to the process stdout or stderr: it would land on the host's terminal and tear the live area. A handler reports through `ctx.log.<level>(source, message, data)` (`PluginLogger`, the host prefixes the plugin id) or returns a `CommandResult`. Lib code outside a handler takes an optional callback. The oxlint rule `ma/no-direct-stdio` (from core, `node_modules/@minimal-agent/core/scripts/lint/`) enforces it, and `tests/no-direct-stdio.test.ts` keeps `tests/no-direct-stdio.baseline.json` exact. Only a process entry may write: a `cli.ts`, a `bin/*.ts` daemon, a backend subprocess, a dev script. After a fix, shrink the list with `node node_modules/@minimal-agent/core/scripts/lint/verify-no-direct-stdio.mjs --repo . --baseline tests/no-direct-stdio.baseline.json --sync`.

## Core pin (`bun run pin:core`)

The root `package.json` and many plugin `package.json` files name
`@minimal-agent/core` as a git dependency:
`git+ssh://git@github.com/gastonmorixe/minimal-agent-core.git#<sha>`.

- Every pin must use the same full 40-char SHA. Short SHAs and branch names
  are not allowed.
- To re-pin, run `bun run pin:core <40-char sha>`. With no SHA, it uses core
  `main` from `git ls-remote`.
- The script sets the SHA in every `dependencies`, `devDependencies`,
  `peerDependencies` and `optionalDependencies` field (root and every
  package). It shows `old -> new` per file, then runs `bun install`.
- Do not edit only the root pin. `scripts/core-pin.test.ts` (part of
  `bun run check`) fails when any `package.json` or local `bun.lock` entry
  uses a different SHA than the root pin.
- `bun.lock` is in `.gitignore`. Commit the `package.json` files only.

## Git commits (Conventional Commits)

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `chore:`, …). Husky + Commitlint enforce this on `commit-msg`
(`commitlint.config.js`, `.husky/commit-msg`; wired by `prepare` → `husky` on
install). CI runs a `commitlint` job (`bun run commitlint:last` on push; range
lint on PRs). Local check: `echo 'feat: ok' | bun run commitlint`.

## Git commits (agent Co-authored-by trailer)

Every commit made by an agent must include a `Co-authored-by` trailer for the
**current session** (name + short session id). This is a **local audit trail**
("which agent session authored this commit"). It is **not** a GitHub co-author,
not a second GitHub user, and not GitHub contributor attribution.

Format:

```
Co-authored-by: {Name} <{short-sid}@minimal-agent>
```

- `{Name}` — session name (`MINIMAL_AGENT_AGENT_NAME` / `SessionInfo` / TUI),
  e.g. `Veronica`
- `{short-sid}` — first 8 hex characters of `MINIMAL_AGENT_SESSION_ID`, e.g.
  `9b615852` from `9b615852-…`

Example:

```
Co-authored-by: Veronica <a26a1e75@minimal-agent>
```

Put the trailer on its own line at the end of the commit message with a blank
line before it. Prefer a HEREDOC so git keeps the trailer:

```bash
git commit -m "$(cat <<'EOF'
fix: explain the change briefly.

Co-authored-by: Veronica <a26a1e75@minimal-agent>
EOF
)"
```

Or append with Git's native flag:

```bash
git commit -m "fix: explain the change briefly." \
  --trailer "Co-authored-by: Veronica <a26a1e75@minimal-agent>"
```

**Enforcement:** when `MINIMAL_AGENT_SESSION_ID` is set, `.husky/commit-msg`
runs `scripts/check-agent-coauthor.sh` after Commitlint. Missing or wrong
trailers (sid / name) fail the commit. Human commits (env unset) are not gated.
Agents must not bypass with `--no-verify`.
