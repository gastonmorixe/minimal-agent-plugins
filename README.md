# minimal-agent-plugins

External user plugins for [minimal-agent][ma]. Each top-level directory is a
self-contained plugin package consumed by minimal-agent's plugin loader.

[ma]: https://github.com/gastonmorixe/minimal-agent

## Loader discovery

minimal-agent walks three roots in precedence order (closer-to-user wins):

1. `<cwd>/.agents/tui-plugins/` (project-local)
2. `~/.agents/tui-plugins/` (per-user, home)
3. `<agent-install>/tui-plugins/` (shipped built-ins)

Plugins from this repo install into the **home root** by symlinking the
plugin directory into `~/.agents/tui-plugins/`:

```bash
ln -s ~/minimal-agent-plugins/ma-fetch-plugin ~/.agents/tui-plugins/ma-fetch-plugin
```

## Plugins in this repo

| Directory | Tool(s) | Purpose |
|-----------|---------|---------|
| [`ma-agent-writing-style-plugin/`](./ma-agent-writing-style-plugin) | none (pure prompt) | Opinionated agent writing style. Hard-bans em-dashes and semicolons, kills the AI vocabulary, suppresses sycophancy and significance inflation. Output sounds like a person, not AI slop. |
| [`ma-fetch-plugin/`](./ma-fetch-plugin) | `Fetch` | Fetch web pages with JS rendering (default backend: [obscura][o]) |
| [`ma-skills-plugin/`](./ma-skills-plugin) | `Skill` | [Agent Skills][as] support: discovers `SKILL.md` packs from project / home / user roots and exposes them via progressive disclosure |

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

## Running tests

```bash
bun test
```

Tests live next to the code they exercise (`foo.ts` ↔ `foo.test.ts`).
