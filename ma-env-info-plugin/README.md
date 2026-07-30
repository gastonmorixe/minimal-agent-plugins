# env-info plugin

Captures a one-shot snapshot of the host environment (OS, arch, CPU
count, terminal size, current date, git state, etc.) and injects it
into the system prompt at session start.

The snapshot is **frozen for the rest of the session** so the cached
system prompt stays byte-stable (memoized by `PluginLoader.getPromptBlockAsync`).
Volatile values like the current time and terminal size won't refresh.

## What it contributes

| Surface                    | Value                       |
| -------------------------- | --------------------------- |
| `manifest.promptFragments` | one entry, `id: "snapshot"` |

The fragment's handler is the bundled `gather.sh` script (a subprocess
producer): the loader runs it once during the first async prompt
assembly, captures stdout, and injects it as **plain markdown** via
`placement: "afterInstructions"`.

That placement is intentional: the absolute `cwd=` (and the rest of the
snapshot) must survive `--no-system-session-context` /
`systemPrompt.sessionContext` omit. Plugin PROMPT.md / sessionContext
XML is still optional framing; the snapshot itself is not sessionContext.

## Files

- `manifest.json`: declares the prompt fragment + subprocess command
  (`placement: "afterInstructions"`).
- `gather.sh`: collects the host facts and emits the full `# Environment`
  markdown (heading + note + fenced `ini`). Designed to be fast, never
  network-touching, and to fail closed (empty output, never a crash).
- `PROMPT.md`: intentionally empty. Framing lives in the fragment so the
  snapshot does not depend on sessionContext / PROMPT.md composition.

## Format

INI-style `key=value` lines, one per attribute, wrapped in a markdown
code fence with `ini` syntax. Keys are stable; new attributes append
to the end.

## Agent identity fields

The snapshot includes the agent-process identity via the
`MINIMAL_AGENT_*` env vars the loader injects via
`agentContextToEnv` (see `src/plugins/agent-context.ts`):

- `session_id` ← `MINIMAL_AGENT_SESSION_ID` (UUID v4, per-process)
- `pid` ← `MINIMAL_AGENT_PID` (agent's Bun process id;
  falls back to `$PPID` when run outside the agent)
- `model` ← `MINIMAL_AGENT_MODEL` (resolved model id)
- `version` ← `MINIMAL_AGENT_VERSION` (agent semver)

## Disabling

`plugins["env-info"].enabled = false` in `~/.minimal-agent/config.jsonc`.
Removes both the fragment and the wrapper from the system prompt.
