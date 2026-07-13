# ma-skills-plugin

Agent Skills support for [minimal-agent][ma]. Discovers `SKILL.md` packs
from project / home-shared / user-agent roots and exposes them via
progressive disclosure (a Level-1 catalog injected into the system
prompt + a `Skill` tool for on-demand load).

Implements the open [Agent Skills][as] standard.

[ma]: https://github.com/gastonmorixe/minimal-agent-core
[as]: https://agentskills.io

## What's an Agent Skill?

A folder containing at minimum a `SKILL.md` file with YAML frontmatter
(`name`, `description`) and a markdown body. Optional siblings:

```
my-skill/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
├── assets/           # Optional: templates, resources
└── …                 # Anything else
```

See the spec for the full grammar: <https://agentskills.io/specification>.

## Install

```bash
git clone https://github.com/gastonmorixe/minimal-agent-plugins.git
ln -sfn "$PWD/ma-skills-plugin" ~/.agents/plugins/ma-skills-plugin
```

Next time you launch minimal-agent, the plugin loader picks it up
automatically. The startup tree's `tools` row will include
`✦ Skill`.

## Discovery roots (precedence highest → lowest)

| Tier | Path | Scope |
|---|---|---|
| 1 | `<cwd>/.agents/skills/` | project, this repo |
| 2 | `<cwd>/.claude/skills/` | project, Claude Code interop (opt-in) |
| 3 | `~/.agents/skills/` | home, shared with other agents |
| 4 | `~/.minimal-agent/skills/` | user, agent-specific |
| 5 | extras from config | lowest |

Collisions resolved by skill `name`. Closer-to-user wins. Lower-precedence
collisions are listed under "Shadowed" in the catalog (and `Skill list`).

## Progressive disclosure

| Spec level | Mechanism in minimal-agent |
|---|---|
| **L1** Metadata | `promptFragments` injects `name`+`description`+`scope`+`path` at session start. |
| **L2** Instructions | `Skill {action: "read", name}` returns the full SKILL.md body. |
| **L3** Resources | Use `Read` / `Bash` on `scripts/`, `references/`, `assets/`. |

## The `Skill` tool

```
Skill {action: "list"}                 → enumerate everything (JSON + ANSI table)
Skill {action: "info", name: "<n>"}    → frontmatter only (no body load)
Skill {action: "read", name: "<n>"}    → full SKILL.md body + sibling trailer
```

Read responses include a `_truncCtx` so minimal-agent's universal output
guardrail can clamp pathological `SKILL.md` files cleanly.

## Configuration

User config at `~/.minimal-agent/config.jsonc` under `plugins["ma-skills"]`:

```jsonc
{
  "plugins": {
    "ma-skills": {
      "enabled": true,
      "roots": {
        "project":            true,
        "projectClaudeCode":  false,   // .claude/skills/ interop
        "homeShared":         true,
        "userAgent":          true
      },
      "extraRoots":            [],
      "maxSkills":             64,
      "allowReservedNames":    false   // permit `claude`/`anthropic` in names
    }
  }
}
```

All keys are optional with the defaults shown. To disable the plugin
entirely, set `enabled` to `false` (or omit the symlink, since the loader
only picks up what's there).

## Example skill

```
~/.minimal-agent/skills/git-tidy/SKILL.md:

---
name: git-tidy
description: Bring a messy local git tree back to a clean, reviewable state. Use when the user mentions cleaning up uncommitted changes, squashing WIP commits, or rebasing onto a fresh main.
license: MIT
allowed-tools: Bash(git:*) Read
metadata:
  author: gaston
---

# git-tidy

1. Inspect the state of the tree with `git status -sb` and `git log --oneline -20`.
2. …
```

The model sees this skill listed in the catalog at startup. When the
user asks "clean up my branch", the model calls `Skill {action: "read",
name: "git-tidy"}`, gets the full body, follows the steps, respecting
the `allowed-tools` constraint to use only `git` commands and `Read`.

## Spec compliance

The frontmatter parser implements every rule on the spec page including
the explicit valid + invalid examples:

- `name`: 1–64 chars, `^[a-z0-9]+(-[a-z0-9]+)*$`, no XML tags, must
  match parent directory name, reserved-word guard for
  `anthropic`/`claude` (opt-out via `allowReservedNames`).
- `description`: 1–1024 chars, no XML tags.
- `license`: free-form string.
- `compatibility`: ≤500 chars.
- `metadata`: nested string→string map.
- `allowed-tools` (experimental): space-separated token list. Both
  kebab-case (`allowed-tools`) and the legacy camelCase (`allowedTools`)
  are accepted.

Body is preserved verbatim. Multiple validation errors are collected and
reported together so users see all problems at once.

## Security

Skills are code + prompts that direct agent behavior. The standard
warning applies:

> Use Skills only from trusted sources … If you must use a Skill from an
> untrusted or unknown source, exercise extreme caution and thoroughly
> audit it before use.

The plugin does not sandbox script execution. `scripts/extract.py`
runs with the agent's full privileges via `Bash`. Audit third-party
skills before installing them.

## Development

```bash
# from the repo root
bun test ma-skills-plugin/

# or just one suite
bun test ma-skills-plugin/lib/skill-md.test.ts
```

176/176 tests passing across 6 files at the time of writing.
