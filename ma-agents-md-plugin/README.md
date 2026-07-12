# agents-md plugin

Loads [AGENTS.md](https://agents.md) files into the system prompt at session
start so the model gets project and user guidance without a manual paste.

## What it injects

| Source | Path | Order |
|---|---|---|
| Global | `<agent-home>/AGENTS.md` | first |
| Project | `<cwd>/AGENTS.md` | second |

`agent-home` is **not** hardcoded as `~/.minimal-agent`. The host publishes the
resolved home as `MINIMAL_AGENT_HOME` at boot (honoring relocation /
`MINIMAL_AGENT_HOME` overrides); this plugin reads that env var via a local
`agentHome()` helper, the same pattern as skills/memory.

Bodies are injected raw (joined with a blank line, global then project). No
framing headers, intro prose, or path headings are prepended.

When neither file exists (or both are empty), the fragment returns the empty
string and the host loader omits it from the system prompt.

## System-prompt placement (legacy + modern SDK)

The fragment is a standard `manifest.promptFragments` producer with
`placement: "afterInstructions"`. The host loader runs it once, memoizes the
text, and emits it as **plain markdown** (no `<ma::sys::…>` wrap, no
`PROMPT.md` merge) immediately after the cached instructions block:

- **Loader dual API**: `loader.getPromptBlocksAsync().afterInstructions`
- **Legacy `Agent` / `AgentCore`**: consumers must pass that field into
  `resolveSystemPromptForModel({ afterInstructions })` (core Phase 4). Until
  that lands, the body is produced correctly by the loader but not yet
  assembled into the live system prompt path that still only reads
  `sessionContext`.

There is no residual `PROMPT.md` on this package so sessionContext does not
get a second empty/XML framing section for AGENTS content.

## Disabling

Any of:

```bash
minimal-agent --no-agents-md
minimal-agent --disable-plugin agents-md
MINIMAL_AGENT_NO_AGENTS_MD=1 minimal-agent
```

Or in `~/.minimal-agent/config.jsonc` (or your relocated agent home):

```jsonc
{
  "plugins": {
    "agents-md": {
      "enabled": false
    }
  }
}
```

## Config knobs

```jsonc
{
  "plugins": {
    "agents-md": {
      // host-level on/off (see above)
      "enabled": true,
      // load <agent-home>/AGENTS.md (default true)
      "global": true,
      // load <cwd>/AGENTS.md (default true)
      "project": true,
      // per-file size cap in bytes; oversized files are skipped (default 100000)
      "maxBytes": 100000
    }
  }
}
```

## Layout

```
ma-agents-md-plugin/
├── manifest.json          # id: agents-md, placement: afterInstructions
├── handlers/load.ts       # prompt-fragment producer
├── lib/load.ts            # pure collect + raw body join (no framing)
├── lib/config.ts          # plugins["agents-md"] reader
├── lib/agent-home.ts      # MINIMAL_AGENT_HOME resolution
├── lib/jsonc.ts           # vendored JSONC parser
├── lib/host-types.ts      # structural PromptFragmentContext slice
└── README.md
```

## Cache note

The fragment is frozen for the session (host memoizes prompt fragments so the
system prompt stays byte-stable for prompt caching). Edits to AGENTS.md mid-
session do not refresh until the next session.
