# minimal-agent-plugins

First-party plugins for [minimal-agent][ma]. Each top-level `ma-*-plugin/`
directory is a self-contained package consumed by the agent's plugin loader.

[ma]: https://github.com/gastonmorixe/minimal-agent-core

## Loader discovery

minimal-agent walks these roots in precedence order (closer-to-user wins):

1. `<cwd>/.agents/plugins/` — project-local
2. `~/.agents/plugins/` — per-user home
3. `~/.minimal-agent/plugins/` — first-party tree (auto-cloned on first run)
4. A sibling `minimal-agent-plugins/` directory next to a source checkout (dev)

To develop against a local checkout, symlink packages into the home root:

```bash
mkdir -p ~/.agents/plugins
ln -sfn "$PWD/ma-fetch-plugin" ~/.agents/plugins/ma-fetch-plugin
```

Or clone this repository once into the runtime plugins directory:

```bash
git clone https://github.com/gastonmorixe/minimal-agent-plugins.git ~/.minimal-agent/plugins
```

## Plugins in this repository

| Directory | Tool(s) | Purpose |
|-----------|---------|---------|
| [`ma-agent-writing-style-plugin/`](./ma-agent-writing-style-plugin) | none (pure prompt) | Opinionated agent writing style. Hard-bans em-dashes and semicolons, kills the AI vocabulary, suppresses sycophancy and significance inflation. |
| [`ma-background-plugin/`](./ma-background-plugin) | `BackgroundRun`, `BackgroundStatus`, `BackgroundLogs`, `BackgroundStop` | Run shell commands in the background, check status, read logs, cancel. Durable logs colocated with session history. |
| [`ma-fetch-plugin/`](./ma-fetch-plugin) | `Fetch` | Fetch web pages with JS rendering (default backend: [obscura][o]) |
| [`ma-skills-plugin/`](./ma-skills-plugin) | `Skill` | [Agent Skills][as] support: discovers `SKILL.md` packs and exposes them via progressive disclosure |
| [`ma-speak-plugin/`](./ma-speak-plugin) | `Speak`, `SpeakStatus`, `SpeakStop` | Read text aloud through a swappable speech backend (default: macOS `say`) |

This table is a sample of the tree. Provider plugins (`ma-llm-*`), intercom,
sub-agents, tasks, memory, diagnostics, and others live alongside these
directories; see each package's own `README.md`.

[o]: https://github.com/h4ckf0r0day/obscura
[as]: https://agentskills.io

## Layout convention

```
<plugin-dir>/
├── manifest.json       # plugin metadata + tool/mode/event declarations
├── PROMPT.md           # system-prompt fragment (when/how the model uses it)
├── README.md           # human-facing install + dev notes
├── handlers/           # tool-call handlers (TS modules)
├── lib/                # shared helpers (config, utils, types)
└── backends/           # swappable backend scripts (when applicable)
```

## Develop

```bash
bun install
bun run check
bun test
```

Tests live next to the code they exercise (`foo.ts` ↔ `foo.test.ts`).

## Related repositories

- Core harness: [minimal-agent-core](https://github.com/gastonmorixe/minimal-agent-core)
- Monorepo (pinned pair): [minimal-agent](https://github.com/gastonmorixe/minimal-agent)

## License

Copyright (c) 2025–2026 Gaston Morixe. All rights reserved.

This software is proprietary and confidential. No license is granted to use,
copy, modify, merge, publish, distribute, sublicense, or sell copies of the
software except as expressly authorized in writing by the copyright holder.
See [LICENSE](./LICENSE).
