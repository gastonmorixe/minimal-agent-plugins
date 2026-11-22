# minimal-agent-plugins

The first-party plugins of minimal-agent. Each top-level `ma-*-plugin/`
directory is one package that the plugin loader of
[minimal-agent-core][core] loads. Providers, tools, modes, the system prompt
and the terminal extras are all plugins: core holds the loop and the
contracts, and no model-facing text.

[core]: https://github.com/gastonmorixe/minimal-agent-core

## Work in the monorepo

This repo is a git submodule of
[gastonmorixe/minimal-agent](https://github.com/gastonmorixe/minimal-agent)
(the monorepo). Do the daily work there, not in a clone of this repo alone.
Its [README](https://github.com/gastonmorixe/minimal-agent#readme) has the
full workflow. The parts that matter for plugins:

- **Install once, at the monorepo root.** `bun install` there links the
  local core checkout into every plugin package. An edit in core or in a
  plugin is live at the next `bun run start`, with no commit and no pin to
  move. `bun install` in this folder is the same root install.
- **Run `bun run hooks` once after a clone**, at the monorepo root. It sets
  up the commit message hook. `bun install` does that too, but not when
  lifecycle scripts are off on your machine.
- **Make a branch before you commit.** The monorepo checks out each
  submodule at one recorded commit, on no branch (a "detached HEAD"). Run
  `git switch -c <name>` first. A commit on no branch is hard to find again.
- **Land here first, then record it.** Push the commit to `main` of this
  repo. Then, at the monorepo root, run `git add minimal-agent-plugins`,
  commit and push. The monorepo CI is the full gate.
- **`bun run pins`** at the monorepo root shows the state of every pin and
  the next command to run.

## How the CLI finds plugins

The CLI gives core three plugin roots. For one plugin id, project wins, then
user, then embedded:

1. **Project:** `<cwd>/.agents/minimal-agent/plugins/`.
2. **User:** `~/.minimal-agent/plugins/`. The CLI clones this repo there
   one time, and only when there is no checkout (install mode).
3. **Embedded:** the `minimal-agent-plugins/` checkout next to the CLI repo
   (dev mode). `MINIMAL_AGENT_PLUGIN_SIBLINGS` (colon-separated dirs)
   replaces that directory.

Dev mode: when the checkout holds at least one plugin package, the user root
is empty and the CLI does not clone. That is the case in the monorepo, so an
edit here needs no symlink and no copy.

A compiled `minimal-agent` binary carries every plugin of this repo inside
it, below all three roots. It needs no clone, and a project or user copy of a
plugin id still wins.

To add a plugin for one project only, put or symlink the package into the
project root:

```bash
mkdir -p .agents/minimal-agent/plugins
ln -sfn /path/to/minimal-agent-plugins/ma-fetch-plugin .agents/minimal-agent/plugins/ma-fetch-plugin
```

The CLI does not read `~/.agents/plugins/` or `<cwd>/.agents/plugins/`. It
prints a warning when one of them holds plugin packages.

`minimal-agent plugins list` shows each plugin that a run finds, with its id
and its on or off state. Turn one off with `--disable-plugin <id>` or
`"plugins": { "<id>": { "enabled": false } }` in the config. The id is in the
tables below. It is not always the directory name.

## Plugins in this repository

Each directory name links to the package. Most packages have a `README.md`.

### Model text and contracts

Core asks these plugins for the text that the model or the user reads.
"Required" means that a run cannot disable the plugin.

| Directory | Id | Purpose |
| --- | --- | --- |
| [`ma-base-prompt-plugin/`](./ma-base-prompt-plugin) | `ma-base-prompt-plugin` | Required. The base system prompt: the neutral identity and the instructions. |
| [`ma-core-tools-plugin/`](./ma-core-tools-plugin) | `ma-core-tools-plugin` | Required. The text of the 8 built-in tools: descriptions, results, output notices, and mode texts. |
| [`ma-turn-recovery-plugin/`](./ma-turn-recovery-plugin) | `turn-recovery` | Required. The text that core uses to recover a turn: continue nudges, the assistant placeholder, and turn markers. |
| [`ma-prompt-template-plugin/`](./ma-prompt-template-plugin) | `ma-prompt-template-plugin` | Required. Fills the `%%name%%` placeholders in plugin prompt files. |
| [`ma-sideband-plugin/`](./ma-sideband-plugin) | `sideband` | Required. The sideband codec (the `<ma::…>` tags): writes the current form, reads the old forms, and makes untrusted text safe. |
| [`ma-host-text-plugin/`](./ma-host-text-plugin) | `ma-host-text-plugin` | The text of core errors that the user reads, for example boot errors. |

### System prompt parts

| Directory | Id | Purpose |
| --- | --- | --- |
| [`ma-agents-md-plugin/`](./ma-agents-md-plugin) | `agents-md` | Loads `AGENTS.md` files into the system prompt. |
| [`ma-env-info-plugin/`](./ma-env-info-plugin) | `env-info` | Adds a snapshot of the host environment (OS, terminal, date, git state) at session start. |
| [`ma-agent-identity-plugin/`](./ma-agent-identity-plugin) | `agent-identity` | Gives the agent a display name for the session. |
| [`ma-agent-writing-style-plugin/`](./ma-agent-writing-style-plugin) | `ma-agent-writing-style` | Adds writing style rules, so the model writes plain prose. |

### Tools

| Directory | Id | Tools | Purpose |
| --- | --- | --- | --- |
| [`ma-background-plugin/`](./ma-background-plugin) | `ma-bg` | `BackgroundRun`, `BackgroundStatus`, `BackgroundLogs`, `BackgroundStop` | Run shell commands in the background, read their logs, and stop them. |
| [`ma-fetch-plugin/`](./ma-fetch-plugin) | `ma-fetch` | `Fetch` | Get web pages with a headless browser that runs JavaScript (default backend: [obscura][o]). |
| [`ma-web-search-plugin/`](./ma-web-search-plugin) | `web-search` | `WebSearch` | Search the web through a provider chain. The default provider is Brave. |
| [`ma-skills-plugin/`](./ma-skills-plugin) | `ma-skills` | `Skill` | [Agent Skills][as]: finds `SKILL.md` packs and loads one when a task needs it. |
| [`ma-sub-agents-plugin/`](./ma-sub-agents-plugin) | `sub-agents` | `SubAgentsSpawnAgent`, `SubAgentsListAgents`, `SubAgentsAgentStatus`, `SubAgentsAgentResult`, `SubAgentsAgentOutput`, `SubAgentsStopAgent`, `SubAgentsMailbox`, `SubAgentsReportResult` | Start background agents, monitor them, and get their results. |
| [`ma-tasks-plugin/`](./ma-tasks-plugin) | `tasks` | `Task` | A task list for the session that the user sees live. |
| [`ma-memory-plugin/`](./ma-memory-plugin) | `memory` | `MemoryTool`, the `<ma::emit::memory>` tag | Memory that stays between sessions, and a short-term scratchpad for one session. |
| [`ma-prompts-plugin/`](./ma-prompts-plugin) | `ma-prompts` | `PromptNew`, `PromptList`, `PromptShow`, `PromptEdit`, `PromptDelete` | A library of saved prompts, with the `&` menu. |
| [`ma-schedule-plugin/`](./ma-schedule-plugin) | `schedule` | `ScheduleCronCreate`, `ScheduleCronList`, `ScheduleCronDelete`, `ScheduleCronReschedule`, `/loop`, `/schedule` | Run prompts at set times or at an interval. |
| [`ma-intercom-plugin/`](./ma-intercom-plugin) | `intercom` | `IntercomPeers`, `IntercomSend`, `IntercomInbox` | Messages and presence between the sessions on one computer. |
| [`ma-file-lock-plugin/`](./ma-file-lock-plugin) | `file-lock` | `LockStatus` | File locks, so that two agents in one worktree do not write the same file. |
| [`ma-compact-plugin/`](./ma-compact-plugin) | `compact` | `CompactContext` | Lets the model ask for a context compaction. |
| [`ma-model-info-plugin/`](./ma-model-info-plugin) | `model-info` | `ModelInfo` | Lets the model read what its model can do. |
| [`ma-session-info-plugin/`](./ma-session-info-plugin) | `session-info` | `SessionInfo` | Live session state: context use, quota, cost, time. |
| [`ma-session-history-plugin/`](./ma-session-history-plugin) | `session-history` | `SessionHistory` | Read a saved session in pages. |
| [`ma-diff-view-plugin/`](./ma-diff-view-plugin) | `diff-view` | `DiffViewerShowDiff`, the `<ma::emit::diff>` tag | Shows diffs in color. |
| [`ma-emit-output-plugin/`](./ma-emit-output-plugin) | `emit-output` | the `<ma::emit::output>` tag | Shows a file or a saved output in the response. The model does not copy the bytes. |
| [`ma-speak-plugin/`](./ma-speak-plugin) | `ma-speak` | `Speak`, `SpeakStatus`, `SpeakStop` | Speaks text through a voice backend (default: macOS `say`). |
| [`ma-chrome-cdp-plugin/`](./ma-chrome-cdp-plugin) | `ma-chrome-cdp` | `ChromeCDP` | Controls an open Chrome through the DevTools Protocol. macOS only. |
| [`ma-computer-use-plugin/`](./ma-computer-use-plugin) | `ma-computer-use` | `Computer` | Controls the Mac: the Accessibility tree, mouse, keyboard, screenshots. macOS only. |
| [`ma-diagnostics-plugin/`](./ma-diagnostics-plugin) | `diagnostics` | none | Adds LSP, linter and formatter results after each `Edit` or `Write`. |
| [`ma-cache-plugin/`](./ma-cache-plugin) | `cache` | none | Tells you each time that the prompt cache did not engage, with the cause. |

A plugin tool gets the plugin name as a prefix (`Intercom` + `Send` gives
`IntercomSend`), unless that tool sets `explicitName: true`. The prefix is the
manifest `name` in CamelCase (`Sub-agents` gives `SubAgents`), or `camelName`
when the manifest sets it.

[o]: https://github.com/h4ckf0r0day/obscura
[as]: https://agentskills.io

### Modes, hooks and policy

| Directory | Id | Purpose |
| --- | --- | --- |
| [`ma-ask-mode-plugin/`](./ma-ask-mode-plugin) | `ask-mode` | The read-only `ASK` mode. `Edit` and `Write` are refused, and the model gives the change as a diff. |
| [`ma-hooks-plugin/`](./ma-hooks-plugin) | `hooks` | Runs shell and HTTP hooks from `hooks.json`. Adds `/hooks`. |
| [`ma-dry-run-plugin/`](./ma-dry-run-plugin) | `dry-run` | Off by default. Prints the full model request as JSON and does not send it (`--dry-run`). |
| [`ma-interleave-thinking-plugin/`](./ma-interleave-thinking-plugin) | `interleave-thinking` | Off by default. Hides `<ma::emit::interleave-thinking>` spans from the output. |
| [`ma-reflection-checkpoint-plugin/`](./ma-reflection-checkpoint-plugin) | `reflection-checkpoint` | Off by default. Adds a soft reflection checkpoint after each N tool rounds (default 50), with a cooldown that Esc skips. The model can skip the next K checkpoints with `<ma::emit::reflection-ack />`. |
| [`ma-security-plugin/`](./ma-security-plugin) | `security` | Off by default. A skeleton for secret redaction and a tool guard. Adds `SecurityStatus` and `/security`. |
| [`ma-policy-ref-plugin/`](./ma-policy-ref-plugin) | `policy-ref` | Off by default. A reference policy plugin, used as a test fixture. |
| [`ma-agent-cloud/`](./ma-agent-cloud) | `minimal-agent-cloud` | Off by default. The connector to the cloud backend. Adds `CloudStatus`, `CloudLogin`, `CloudPush`. |

### Terminal extras

| Directory | Id | Purpose |
| --- | --- | --- |
| [`ma-config-plugin/`](./ma-config-plugin) | `config` | `/config`: an editor for `~/.minimal-agent/config.jsonc`. |
| [`ma-usage-plugin/`](./ma-usage-plugin) | `usage` | `/usage`: token use and cost of the saved sessions. |
| [`ma-slash-menu-plugin/`](./ma-slash-menu-plugin) | `ma-slash-menu` | The `/` command menu and the `$` skills menu. |
| [`ma-history-plugin/`](./ma-history-plugin) | `history` | Up and down arrow recall of earlier prompts. |
| [`ma-paste-plugin/`](./ma-paste-plugin) | `paste` | A text paste goes to a session file. The editor holds a short ref, and each send expands it. |
| [`ma-history-edit-plugin/`](./ma-history-edit-plugin) | `history-edit` | `/history-edit`: change an earlier prompt of the session and continue from there. |
| [`ma-quota-status-plugin/`](./ma-quota-status-plugin) | `quota-status` | The quota line in the footer. |
| [`ma-tps-plugin/`](./ma-tps-plugin) | `tps` | Tokens per second, on the quota line. |
| [`ma-header-template-plugin/`](./ma-header-template-plugin) | `header-template` | A custom start header from a `%%name%%` template (`--header-format`). |

### Host modes

| Directory | Id | Purpose |
| --- | --- | --- |
| [`ma-acp-plugin/`](./ma-acp-plugin) | `acp` | `--host-mode acp`: runs the agent as an Agent Client Protocol server for an editor. |

### Providers

A provider plugin has a `provider.json`, not a `manifest.json`. Its id is the
value of `--provider`.

| Directory | Id | Backend |
| --- | --- | --- |
| [`ma-llm-anthropic-plugin/`](./ma-llm-anthropic-plugin) | `anthropic` | Anthropic Messages API |
| [`ma-llm-openai-plugin/`](./ma-llm-openai-plugin) | `openai` | OpenAI Chat Completions and Responses |
| [`ma-llm-ollama-plugin/`](./ma-llm-ollama-plugin) | `ollama` | Ollama Cloud |
| [`ma-llm-openrouter-plugin/`](./ma-llm-openrouter-plugin) | `openrouter` | OpenRouter gateway |
| [`ma-llm-wafer-plugin/`](./ma-llm-wafer-plugin) | `wafer` | Wafer Serverless gateway |
| [`ma-llm-opencode-go-plugin/`](./ma-llm-opencode-go-plugin) | `opencode-go` | OpenCode Go gateway |
| [`ma-llm-opencode-zen-plugin/`](./ma-llm-opencode-zen-plugin) | `opencode-zen` | OpenCode Zen gateway |
| [`ma-llm-grok-plugin/`](./ma-llm-grok-plugin) | `grok` | xAI Grok |
| [`ma-llm-huggingface-plugin/`](./ma-llm-huggingface-plugin) | `huggingface` | HuggingFace Inference Providers gateway |
| [`ma-llm-meta-plugin/`](./ma-llm-meta-plugin) | `meta` | Meta Model API |
| [`ma-llm-clinepass-plugin/`](./ma-llm-clinepass-plugin) | `clinepass` | ClinePass |
| [`ma-llm-cursor-plugin/`](./ma-llm-cursor-plugin) | `cursor` | Cursor agent service |
| [`ma-llm-generic-endpoint-plugin/`](./ma-llm-generic-endpoint-plugin) | `generic-endpoint` | Any OpenAI-compatible endpoint, set at run time |

### Kits (shared code, not plugins)

| Directory | Purpose |
| --- | --- |
| [`ma-autocomplete-kit/`](./ma-autocomplete-kit) | An autocomplete menu for the prompt editor. The prompts plugin uses it for the `&` menu. |
| [`ma-template-kit/`](./ma-template-kit) | The `%%name%%` template engine. The prompt template and header template plugins use it. |
| [`ma-token-estimate-kit/`](./ma-token-estimate-kit) | Token-estimate presets for each tokenizer family, and a model id to family map. The `ma-llm-*` provider plugins use it to set `estimateTokens` on each model. |

## Layout convention

```
<plugin-dir>/
├── manifest.json       # plugin metadata: top-level fields, a `headless` block and a `ui` block
├── package.json        # the workspace package, with its `test` script
├── PROMPT.md           # system-prompt fragment (when/how the model uses it)
├── README.md           # human-facing install + dev notes
├── handlers/           # tool-call handlers (TS modules)
├── lib/                # shared helpers (config, utils, types, style slots)
├── ui/setup.ts         # CLI-only terminal setup (fills the style slots)
└── backends/           # swappable backend scripts (when applicable)
```

Core reads everything in `manifest.json` except the `ui` block: the top-level
fields (`id`, `name`, `enabled`, `required`, `platforms`, `prompt`, the text
contributions) and the `headless` block (tools, hooks, commands, modes). The
CLI loads the `ui` block (`setup`, `liveAreaSlots`). Headless code reads
display styles from plain style slots.
The slots stay plain text until the CLI runs `ui/setup.ts`.

A provider plugin (`ma-llm-*`) has a `provider.json` that names its entry
module, and no `manifest.json`.

## Develop

Run these in this folder, after the root install of the monorepo:

```bash
bun run check            # the full gate of this repo
bun test                 # whole-tree suite (root)
bun run test:plugins     # per-package tests in parallel (bun --filter 'ma-*')
bun test ma-fetch-plugin # the tests of one plugin
```

`bun run check` runs, in order: typecheck, lint (oxlint), format check, Biome
check, the STE check of the prompt text (`bun run ste:gate`, see
[`tests/ste/README.md`](tests/ste/README.md)), and the tests. It stops at the
first failure.

This repo is a Bun workspace: every `ma-*-plugin` and `ma-*-kit` package is a
workspace member.
Toolchain versions live in `workspaces.catalog` at the root and are referenced
as `"catalog:"` from root `devDependencies`.

Tests live next to the code they exercise (`foo.ts` ↔ `foo.test.ts`).

The CI of this repo checks only the commit messages. It cannot install the
private git dependencies. The full gate runs in the monorepo CI, on the
commit that the monorepo records for this repo.

### The core pin

The root `package.json`, and each plugin `package.json` that declares core,
name `@minimal-agent/core` as a git dependency with a commit SHA. All of them
must use the same full 40-char SHA. `scripts/core-pin.test.ts`, a part of the
gate, fails when they differ. Do not edit one pin by hand.

- **In the monorepo**, the pin does not select the core that you run: the
  root install links the local core checkout. After a core change lands, run
  `bun run pins:core` at the monorepo root. It moves the pin here, in the cli
  and in the web repo together.
- **In a clone of this repo alone**, `bun install` gets core at the pinned
  commit, and `bun run pin:core [<sha>]` moves every pin here (see
  [`AGENTS.md`](AGENTS.md)). `bun.lock` is not committed in this repo.

## Releases

A pushed `v<version>` tag that equals the `package.json` version makes a
GitHub release with generated notes. There are no nightlies and no package
on a registry: the CLI reads this repo as a checkout, or embeds it in the
compiled binary.

## Related repositories

- Monorepo (records which commits of the five repos go together): [minimal-agent](https://github.com/gastonmorixe/minimal-agent)
- Engine: [minimal-agent-core](https://github.com/gastonmorixe/minimal-agent-core)
- Terminal client: [minimal-agent-cli](https://github.com/gastonmorixe/minimal-agent-cli)
- Web host: [minimal-agent-web](https://github.com/gastonmorixe/minimal-agent-web)
- Shared Biome, oxlint and TypeScript config: [minimal-agent-config](https://github.com/gastonmorixe/minimal-agent-config)

## License

Copyright (c) 2025–2026 Gaston Morixe. All rights reserved.

This software is proprietary and confidential. No license is granted to use,
copy, modify, merge, publish, distribute, sublicense, or sell copies of the
software except as expressly authorized in writing by the copyright holder.
See [LICENSE](./LICENSE).
