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
  `a26a1e75` from `a26a1e75-…`

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
