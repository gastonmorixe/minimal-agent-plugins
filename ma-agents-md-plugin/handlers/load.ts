/**
 * Prompt-fragment producer for the `agents-md` plugin.
 *
 * Runs once at session start (via the loader's `promptFragments`
 * mechanism). Returns a chunk of markdown that gets folded into the
 * plugin system-prompt block — the same path both the legacy `Agent`
 * loop and the modern `AgentCore` SDK use (`loader.getPromptBlockAsync`
 * → `sessionContext` / `PromptContributorAdapter.systemPromptBlocks()`).
 *
 * Loads:
 *   1. Global: `<MINIMAL_AGENT_HOME>/AGENTS.md`  (user-wide)
 *   2. Project: `<cwd>/AGENTS.md`                (agents.md convention)
 *
 * Global is emitted first; project second. Missing files are silent.
 * Disable for a run with `--no-agents-md`, `--disable-plugin agents-md`,
 * or `plugins["agents-md"].enabled = false` in config.
 *
 * CACHE NOTE: the fragment is memoized for the session by the host
 * loader. Mid-session edits to AGENTS.md do not refresh the system
 * prompt (that would bust the conversation's prompt cache). Restart or
 * open a new session to pick up edits.
 *
 * @module handlers/load
 */

import { loadAgentsMdConfig } from "../lib/config.ts"
import type { PromptFragmentContext } from "../lib/host-types.ts"
import { loadAgentsMdFragment } from "../lib/load.ts"

/**
 * Default export: the prompt-fragment handler the manifest points at.
 * Synchronous and pure aside from the disk reads inside
 * {@link loadAgentsMdFragment}.
 */
export default function agentsMdFragment(ctx: PromptFragmentContext): string {
  const cfg = loadAgentsMdConfig(ctx.env)
  const skips: string[] = []
  const text = loadAgentsMdFragment({
    cwd: ctx.cwd,
    env: ctx.env,
    config: cfg,
    onSkip: (reason) => {
      skips.push(reason)
    },
  })
  for (const reason of skips) {
    ctx.log?.notice?.(reason)
  }
  return text
}
