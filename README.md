# minimal-agent-plugins

First-party plugins for [minimal-agent][ma]. Each top-level `ma-*-plugin/`
directory is a self-contained package consumed by the agent's plugin loader.

[ma]: https://github.com/gastonmorixe/minimal-agent-core

## Loader discovery

The CLI gives core these roots. Core loads them in precedence order (closer
to the user wins):

1. `<cwd>/.agents/minimal-agent/plugins/`: project
2. `~/.minimal-agent/plugins/`: user, first-party tree (cloned on the first
   interactive start, install mode only)
3. Embedded: `<cli>/plugins/`, then a sibling `minimal-agent-plugins/`
   directory next to the CLI checkout (dev). `MINIMAL_AGENT_PLUGIN_SIBLINGS`
   (colon-separated) replaces the sibling directory.

To develop, work in the monorepo checkout. The CLI finds this repository next
to it and loads it as dev mode: the user tier is empty and the CLI does not
clone. For a single project, put or symlink a package into
`<cwd>/.agents/minimal-agent/plugins/`:

```bash
mkdir -p .agents/minimal-agent/plugins
ln -sfn /path/to/minimal-agent-plugins/ma-fetch-plugin .agents/minimal-agent/plugins/ma-fetch-plugin
```

The CLI does not read `~/.agents/plugins/` or `<cwd>/.agents/plugins/`. It
prints a warning when one of them holds plugin packages.

Without a checkout (install mode), you can clone this repository once into
the runtime plugins directory:

```bash
git clone https://github.com/gastonmorixe/minimal-agent-plugins.git ~/.minimal-agent/plugins
```

## Plugins in this repository

| Directory                                                           | Tool(s)                                                                 | Purpose                                                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ma-agent-writing-style-plugin/`](./ma-agent-writing-style-plugin) | none (pure prompt)                                                      | Opinionated agent writing style. Hard-bans em-dashes and semicolons, kills the AI vocabulary, suppresses sycophancy and significance inflation. |
| [`ma-background-plugin/`](./ma-background-plugin)                   | `BackgroundRun`, `BackgroundStatus`, `BackgroundLogs`, `BackgroundStop` | Run shell commands in the background, check status, read logs, cancel. Durable logs colocated with session history.                             |
| [`ma-fetch-plugin/`](./ma-fetch-plugin)                             | `Fetch`                                                                 | Fetch web pages with JS rendering (default backend: [obscura][o])                                                                               |
| [`ma-skills-plugin/`](./ma-skills-plugin)                           | `Skill`                                                                 | [Agent Skills][as] support: discovers `SKILL.md` packs and exposes them via progressive disclosure                                              |
| [`ma-speak-plugin/`](./ma-speak-plugin)                             | `Speak`, `SpeakStatus`, `SpeakStop`                                     | Read text aloud through a swappable speech backend (default: macOS `say`)                                                                       |

This table is a sample of the tree. Provider plugins (`ma-llm-*`), intercom,
sub-agents, tasks, memory, diagnostics, and others live alongside these
directories. Many packages have their own `README.md`. Some (for example most
`ma-llm-*` providers and `ma-sub-agents-plugin`) have none yet.

[o]: https://github.com/h4ckf0r0day/obscura
[as]: https://agentskills.io

## Layout convention

```
<plugin-dir>/
├── manifest.json       # plugin metadata: a `headless` block + a `ui` block
├── PROMPT.md           # system-prompt fragment (when/how the model uses it)
├── README.md           # human-facing install + dev notes
├── handlers/           # tool-call handlers (TS modules)
├── lib/                # shared helpers (config, utils, types, style slots)
├── ui/setup.ts         # CLI-only terminal setup (fills the style slots)
└── backends/           # swappable backend scripts (when applicable)
```

Core loads only the `headless` block of `manifest.json` (tools, hooks,
commands, and other contributions). The CLI loads the `ui` block (`setup`,
`liveAreaSlots`). Headless code reads display styles from plain style slots.
The slots stay plain text until the CLI runs `ui/setup.ts`.

## Develop

```bash
bun install
bun run check
bun test                 # whole-tree suite (root)
bun run test:plugins     # per-package tests in parallel (bun --filter 'ma-*')
bun run pin:core         # re-pin @minimal-agent/core to core main (or pass a SHA)
```

This repo is a Bun workspace: every `ma-*-plugin` and `ma-*-kit` package is a
workspace member.
Toolchain versions live in `workspaces.catalog` at the root and are referenced
as `"catalog:"` from root `devDependencies`. Bump once, `bun install`, done.

Tests live next to the code they exercise (`foo.ts` ↔ `foo.test.ts`).

The root and many plugins name `@minimal-agent/core` as a git dependency with
a commit SHA. All of them must use the same full 40-char SHA. Do not edit one
pin by hand. Run `bun run pin:core [<sha>]` (see [`AGENTS.md`](AGENTS.md)).

## Related repositories

- Core harness: [minimal-agent-core](https://github.com/gastonmorixe/minimal-agent-core)
- Monorepo (pinned pair): [minimal-agent](https://github.com/gastonmorixe/minimal-agent)

## License

Copyright (c) 2025–2026 Gaston Morixe. All rights reserved.

This software is proprietary and confidential. No license is granted to use,
copy, modify, merge, publish, distribute, sublicense, or sell copies of the
software except as expressly authorized in writing by the copyright holder.
See [LICENSE](./LICENSE).
