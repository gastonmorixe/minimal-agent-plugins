# tasks plugin

Per-session task list. Plan multi-step work, mark progress as you go,
the user sees a live TODO. Single `Task` tool with action switch.

## Visual

```
╭ ○ Tasks · ✔ marked done 3 · 3/9
│
│    1  ✔  Add contextSize to SessionTokens
│    2  ✔  Update addSessionUsage callers
│    3  ◐  Update src/session-tokens.test.ts
│       ├  ✔  3a  Zero-state includes contextSize
│       ├  ◐  3b  Replace-not-accumulate semantics
│       ╰  ○  3c  Multi-turn growth pinned
│    4  ○  Update renderSessionSegment in render.ts
│    5  ○  Update showSession gate
│    6  ○  ✘ Remove the legacy cached column  (canceled by user)
│    7  ○  Run biome format + lint
│    8  ○  Run full test suite
│
╰  3 done · 1 doing · 5 todo · 1 canceled
```

Glyphs are pure unicode (no nerd-font, no emoji):

| Glyph | Status   | Color                  |
| ----- | -------- | ---------------------- |
| `○`   | todo     | dim                    |
| `◐`   | doing    | sky (accent)           |
| `✔`   | done     | bold lime              |
| `✘`   | canceled | dim red (title prefix) |

## Files

```
plugins/tasks/
├── manifest.json
├── PROMPT.md                   # model-facing usage rules
├── README.md                   # this file
├── cli.ts                      # `bun run plugins/tasks/cli.ts <cmd>`
├── integration.test.ts
├── lib/
│   ├── parse.ts                # id gen, JSONL serialize/parse, types
│   ├── store.ts                # TaskStore class (CRUD + ordering + rollup)
│   ├── render.ts               # ANSI / plain renderer
│   └── attachment.ts           # <ma::agent::tasks> per-turn producer
└── handlers/
    └── task_tool.ts            # the Task tool dispatch
```

State on disk: `~/.minimal-agent/sessions/<sid>.tasks.jsonl`, one task
per line, order = display order.

## Tool actions

| action         | required                                                  | optional                                            |
| -------------- | --------------------------------------------------------- | --------------------------------------------------- |
| `add`          | `title`                                                   | `parent`, `after`, `status`                         |
| `add_many`     | `tasks[]` (preferred; aliases `items[]`, flat `titles[]`) | `parent` (with flat `titles` only)                  |
| `replace_plan` | `tasks[]` (preferred; aliases `items[]`, flat `titles[]`) |                                                     |
| `update`       | `id`, `title`                                             |                                                     |
| `status`       | `id`, `status`                                            | `reason` (for canceled)                             |
| `start`        | `id`                                                      | `parallel` (compat no-op; start always accumulates) |
| `done`         | `id`                                                      |                                                     |
| `remove`       | `id`                                                      |                                                     |
| `reorder`      | `order[]` (ids)                                           |                                                     |
| `list`         |                                                           | `filter`, `query`, `format`                         |
| `clear`        |                                                           | `force` (if any task `doing`)                       |

Create/list return model-facing plain text using the same canonical ids as the human display. By default, status mutations (`start`/`done`/...) return a short plain-text ack. Set `MINIMAL_AGENT_TASKS_FULL_RESULTS=1` before starting the agent to include the complete updated board in every successful status-mutation result. The session-start Task prompt follows the same setting. Re-`done` of an already-done id is a hard error because parent auto-promotion stays.

`add_many` is always additive. `replace_plan` is the explicit, atomic operation for abandoning the current board and starting a new plan. Canonical ids are session-monotonic, so replacement never reuses an id that a delayed sub-agent might still reference.

### Parent ↔ child lifecycle rollup

The store keeps trees consistent in one write:

- **Child → doing** auto-starts a `todo` or previously `done` parent.
- **Child → done** keeps/marks the parent `doing` while siblings remain open.
- **Last open child → done or canceled** auto-promotes the parent. A canceled child remains visibly canceled, preserving the abandoned-work audit trail without leaving the phase stuck in `doing`.
- **Parent → done** cascades open children (`todo` / `doing`) to `done`. `canceled` children stay canceled.
- A canceled parent is never revived automatically.

## Canonical ids

Roots receive immutable session-monotonic ids such as `1`, `2`, and `3`. Children receive the parent id plus a stable letter suffix such as `1a` or `3c`. Reorder and removal never renumber tasks, so gaps are expected.

Legacy hash references from resumed sessions are migrated to aliases and remain accepted internally. They are not shown or taught to models.

## CLI

```sh
bun run plugins/tasks/cli.ts list
bun run plugins/tasks/cli.ts add "Make plan visible"
bun run plugins/tasks/cli.ts done 1
bun run plugins/tasks/cli.ts status 2 canceled "user redirected"
```

Reads the same session id (`MINIMAL_AGENT_SESSION_ID` env or
`--sid <uuid>` flag) as the in-agent tool.

## Auto-injection

A `<ma::agent::tasks total="…" done="…" doing="…" todo="…" canceled="…">…</ma::agent::tasks>` attachment is prepended to the first user message of every `Agent.run`. Its body is a columnar table with padded columns for position, hash, status, and title. Omitted when zero tasks exist. No token cost unless tasks are in play.

## Design doc

`docs/changes/2026-05-12-feat-tasks-plugin.md` records the alternatives
considered and the rationale for each choice (visual variants, id
scheme, status state machine, on-disk format).
