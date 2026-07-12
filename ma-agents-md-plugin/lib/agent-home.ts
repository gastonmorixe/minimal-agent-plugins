/**
 * The agent home directory, honoring `MINIMAL_AGENT_HOME`.
 *
 * The host is the source of truth: minimal-agent resolves its real home at
 * boot and PUBLISHES it into `process.env.MINIMAL_AGENT_HOME` (see core's
 * `src/agent-paths.ts: publishAgentHomeEnv`), which the loader threads into
 * every plugin context's `env`. So in a live agent this env var is always set
 * and authoritative, and we never hardcode a location the host may have
 * relocated.
 *
 * This is a TINY LOCAL helper on purpose. External plugins must NOT import
 * `@minimal-agent/plugin-api` or anything from the core `src/` at runtime, so
 * we re-derive the home path here rather than share core's implementation.
 *
 * Resolution order (mirrors core `resolveAgentHome`):
 *   1. `MINIMAL_AGENT_HOME` when set and non-blank
 *   2. `$HOME/.minimal-agent` (env HOME, so tests/sandboxes work)
 *   3. `os.homedir()/.minimal-agent` as last resort
 *
 * @module lib/agent-home
 */

import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The agent home, honoring `MINIMAL_AGENT_HOME` (published by the host at
 * boot). When the env var is set (and non-blank) it wins; otherwise
 * `$HOME/.minimal-agent`, else `os.homedir()/.minimal-agent`.
 *
 * The optional `fallbackHome` param (when provided) replaces the HOME /
 * os.homedir() base for callers that already thread an injected home
 * (tests). Absent both the override and the param, behavior matches core.
 */
export function agentHome(env: NodeJS.ProcessEnv = process.env, fallbackHome?: string): string {
  const override = env.MINIMAL_AGENT_HOME?.trim()
  if (override) return override
  if (fallbackHome !== undefined) return join(fallbackHome, ".minimal-agent")
  const home = env.HOME?.trim()
  if (home) return join(home, ".minimal-agent")
  return join(homedir(), ".minimal-agent")
}
