# ma-slash-menu-plugin

Inline command palette for minimal-agent. Triggered by `/` (mixed
actions+skills, **soft** dispatch) or `$` (skills-only, **forced**
activation). Fuzzy autocomplete, arrow-key navigation, Tab to complete,
Esc to cancel. Each row shows the skill's approximate token cost so you
can pick deliberately.

```
  ▸ /swiftui-pro                 review SwiftUI for best practices       ~2.1k  skl
    /swiftui-liquid-glass        iOS 26+ Liquid Glass API                ~3.4k  skl
    /swiftui-ui-patterns         SwiftUI views & components              ~1.8k  skl
    /swift-concurrency-expert    Swift 6.2+ concurrency review           ~5.8k  skl
    /apple-development-official  Xcode-grounded Apple dev guidance      ~12.0k  skl
  ──────────────────────────────────────────────────────  ↓ 32 more
  ↑↓ nav · ⇥ /swiftui-pro · ⏎ load skill · esc close

❯ /swift
```

## Status: design + standalone library (loader-installable as no-op)

The renderer, fuzzy matcher, providers, and token counter are all
implemented, well-tested (82+ tests, all passing), and runnable via
`bun run preview` to see every visual state.

**Wiring into the host REPL's editor requires four core hooks that
don't exist in minimal-agent yet.** See
[Core hooks required](#core-hooks-required) below. Until those land,
the manifest declares only a no-op `promptFragments` entry (a module
handler returning the empty string) so the loader accepts the
manifest and the plugin appears in the startup tree, contributing
zero behavior and zero tokens. The future manifest shape (with
`editorOverlays`, `commandProviders`, and `userMessageHook`)
is documented in [Future manifest shape](#future-manifest-shape)
below. Don't add those fields to `manifest.json` until the matching
core hooks land, or the loader will reject them as unknown.

## Layout

```
ma-slash-menu-plugin/
├── manifest.json                  # plugin manifest (forward-looking shape)
├── PROMPT.md                      # empty (no model-facing surface)
├── README.md                      # this file
├── package.json
├── lib/
│   ├── types.ts                   # Item, Provider, OverlayState, Dispatch
│   ├── fuzzy.ts                   # subsequence matcher + sortByScore
│   ├── scoring.ts                 # scoreItems + applySortMode
│   ├── tokens.ts                  # 4-char heuristic + mtime cache
│   ├── palette.ts                 # local SGR shortcuts (synced with minimal-agent)
│   └── render.ts                  # pure overlay renderer → ANSI string[]
├── providers/
│   ├── actions.ts                 # static built-in commands
│   └── skills.ts                  # SKILL.md discovery + token computation
└── bin/
    └── preview.ts                 # render every canonical state with real skills
```

## Quick start

```sh
cd /path/to/minimal-agent-plugins/ma-slash-menu-plugin
bun test                  # 74 tests, < 30ms
bun run bin/preview.ts    # see every canonical visual state
```

## Triggers

| trigger | scope | dispatch | use when |
|---|---|---|---|
| `/<name> [args…]` | actions + skills | **soft**. Rewrites to a user message that asks the model to activate the skill. The model decides whether to call `Skill read`. | the common case |
| `$<name> [args…]` | skills **only** | **hard**. Agent calls `Skill read` itself, injects the body as a synthetic `tool_use`/`tool_result` pair at turn start. Model cannot skip. | when activation is non-negotiable (e.g. `$swift-concurrency-expert` for a Swift PR review) |

## Item categories

Items carry a category:

- `act`: the host's REGISTERED slash commands, read live from
  `ctx.listCommands()`. These are NOT hardcoded — the menu lists exactly the
  commands that actually dispatch (e.g. `/config`, `/loop`, `/schedule`), so
  selecting one always does something. Any plugin that registers a
  `manifest.commands[]` entry shows up here automatically.
- `skl`: skill packs discovered via SKILL.md.

`providers/actions.ts` is now just a pure `commandItems(CommandInfo[]) → Item[]`
mapping; `lib/state.ts` calls `refreshItems(ctx.listCommands?.())` on each
handler invocation so a newly-registered command appears without a relaunch.

## Token cost chip

Each skill row carries an approximate token count of its SKILL.md body
(4-char heuristic, mtime-keyed cache at
`~/.minimal-agent/cache/ma-slash-menu/tokens.json`). Severity-graded:

| range | color | meaning |
|---|---|---|
| `< 1k` | dim lime | trivial, load freely |
| `1–3k` | faintWhite | normal |
| `3–8k` | gold | notable, worth considering |
| `8–20k` | dim red | heavy, pick deliberately |
| `> 20k` | bold red | very heavy |

On the `$` (forced) menu, the footer adds a `cost: ~Nk of ~Mk ctx`
chip showing the running cost against the active model's context
window. Updates live with selection.

## Provider contract

A provider exposes the items its plugin contributes. Shape:

```ts
interface Provider {
  id: string
  list(): Promise<Item[]> | Item[]
  refreshOn?: string[]   // bus events that invalidate the cache
}

interface Item {
  slug: string            // bare id, no leading "/" or "$"
  description: string
  category: "act" | "skl" | string
  tokens?: number         // approx token cost, shown as severity-graded chip
  payload?: unknown       // opaque, returned to the dispatcher on invoke
  disabled?: boolean
  disabledReason?: string
}
```

The host loader is expected to:

1. Aggregate `commandProviders` from every plugin in declaration order.
2. Dedupe by `(category, slug)`. First-write-wins.
3. Subscribe to `provider.refreshOn` events on the global bus and
   invalidate caches.
4. Pass the combined item set into the overlay state on each open.

## Future manifest shape

Once the four core hooks below land, the manifest grows the
three additional fields (kept here in the README, **not** in
`manifest.json`, because the validator rejects unknown keys):

```jsonc
{
  "editorOverlays": [
    {
      "id": "slash",
      "trigger": { "kind": "buffer-prefix", "prefix": "/", "atColZero": true },
      "captures": ["Up", "Down", "Tab", "Enter", "Escape", "PageUp", "PageDown"],
      "handler": "./lib/overlay.ts",
      "position": "above-editor",
      "maxRows": 5
    },
    {
      "id": "dollar",
      "trigger": { "kind": "buffer-prefix", "prefix": "$", "atColZero": true },
      "captures": ["Up", "Down", "Tab", "Enter", "Escape", "PageUp", "PageDown"],
      "handler": "./lib/overlay.ts",
      "position": "above-editor",
      "maxRows": 5,
      "options": { "mode": "forced" }
    }
  ],
  "commandProviders": [
    { "id": "actions", "handler": "./providers/actions.ts" },
    { "id": "skills",  "handler": "./providers/skills.ts"  }
  ],
  "userMessageHook": {
    "id": "slash-dispatch",
    "handler": "./lib/dispatch.ts",
    "channel": "user.willSubmit"
  }
}
```

When you move these into `manifest.json`, you can drop the
placeholder `promptFragments` entry and delete
`lib/prompt-fragment.ts`.

## Core hooks required

To wire this into minimal-agent's REPL, four hooks need to land. Each
is roughly 50–150 LoC + tests. Together they unlock more than just
ma-slash-menu (e.g. `@`-mentions, inline file picker, completion popups).

### 1. Editor overlay channel

`src/editor-controller.ts` already has `setFooterLines` (rendering
half). It needs a complementary `registerOverlay(spec)` API for the
**input-capture** half:

```ts
interface OverlayHandle {
  /** Update the lines painted above the editor. Empty array hides. */
  setLines(lines: string[]): void
  /** Tear down. Restores key handling to the editor. */
  dismiss(): void
}

interface OverlaySpec {
  /** Should this overlay open given the current buffer? */
  shouldOpen(buffer: string): boolean
  /** Keys to intercept when open. Anything else falls through to editor. */
  captures: KeyName[]
  /** Called for each intercepted key. Return false to dismiss. */
  onKey(key: KeyEvent, handle: OverlayHandle): boolean
  /** Called when buffer changes (printable chars / backspace). */
  onBufferChange(buffer: string, handle: OverlayHandle): void
}

editor.registerOverlay(spec): OverlayHandle
```

Internals: only one overlay active at a time. Editor's `feedInput`
checks each registered spec's `shouldOpen` on buffer change. First
match wins. While open, captured keys go to `onKey`. Uncaptured keys
fall through to the editor. `dismiss()` restores normal flow.

### 2. Manifest `editorOverlays[]` field

`src/plugins/manifest.ts` parses an array of overlay specs from the
plugin manifest:

```jsonc
"editorOverlays": [
  {
    "id": "slash",
    "trigger": { "kind": "buffer-prefix", "prefix": "/", "atColZero": true },
    "captures": ["Up", "Down", "Tab", "Enter", "Escape", "PageUp", "PageDown"],
    "handler": "./lib/overlay.ts",
    "position": "above-editor",
    "maxRows": 5
  }
]
```

Loader instantiates the handler module, builds an `OverlaySpec` from
the manifest fields, and registers via `editor.registerOverlay`.

### 3. `commandProviders` aggregation

`src/plugins/loader.ts` walks every plugin's `commandProviders[]`,
instantiates each handler, and exposes a unified `loader.getCommands()`
that the overlay handler can call. Order is plugin-precedence (project
> home > embedded), then declaration order within a plugin. Dedupes by
`(category, slug)`.

### 4. `user.willSubmit` hook channel

`src/agent.ts` needs a pre-submit channel where plugins can rewrite or
intercept user input. Plugins declare:

```jsonc
"userMessageHook": {
  "id": "slash-dispatch",
  "handler": "./lib/dispatch.ts",
  "channel": "user.willSubmit"
}
```

The handler receives the raw buffer string and returns a `Dispatch`:

```ts
type Dispatch =
  | { kind: "passthrough" }                                  // send as-is
  | { kind: "rewrite"; text: string }                        // replace user text
  | { kind: "injectBefore"; blocks: ContentBlock[]; text: string }  // prefix synthetic blocks
  | { kind: "abort"; message: string }                       // refuse, show error
```

`{ kind: "injectBefore" }` is what `$` uses for hard activation: the
plugin injects a synthetic `assistant: tool_use(Skill, read)` +
`user: tool_result(<SKILL.md body>)` pair before the user's actual
text. Same shape Anthropic uses for prefill activation.

## Configuration

Lives at `~/.minimal-agent/config.jsonc` under `plugins["ma-slash-menu"]`:

```jsonc
{
  "plugins": {
    "ma-slash-menu": {
      "enabled": true,
      "sort": "match-score",      // "match-score" | "cost-asc" | "cost-desc"
      "sortByCostNearQuota": true, // auto-flip to cost-asc near context limit
      "maxRows": 5,
      "showBadge": true           // override degradation to keep / hide badges
    }
  }
}
```

## Adding a new built-in action

Append an entry to `BUILTIN_ACTIONS` in `providers/actions.ts`:

```ts
{
  slug: "mynewthing",
  description: "do the new thing",
  category: "act",
  payload: { actionId: "mynewthing" },
}
```

Then handle `actionId: "mynewthing"` in the host harness's action
router (lives wherever `Dispatch.kind === "action"` is dispatched).

## Adding a new skill

Drop a `SKILL.md` pack into any of the three skill roots:
`~/.minimal-agent/skills/` (user, agent-specific),
`~/.agents/skills/` (home, shared), or
`<cwd>/.agents/skills/` (project, highest precedence). The skills
provider rediscovers on the next `skill.installed` bus event (or next
menu open if the bus isn't wired).

## License

Copyright (c) 2025–2026 Gaston Morixe. All rights reserved.

Proprietary. See the repository [LICENSE](../LICENSE).
