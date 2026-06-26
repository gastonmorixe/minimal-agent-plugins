/**
 * Agent home resolution. Pure path math, no IO.
 *
 * Every `~/.minimal-agent` path this plugin touches (the config file, the
 * session storage sandbox under `sessions/fetch/`) must honor the host's
 * relocation signal. minimal-agent resolves its real home at boot and
 * PUBLISHES it into `process.env.MINIMAL_AGENT_HOME` (see core's
 * `src/agent-paths.ts: publishAgentHomeEnv`), which the loader threads into
 * every plugin context's `env`. So in a live agent this env var is set and
 * authoritative — we never hardcode `~/.minimal-agent` when the host may have
 * moved it.
 *
 * The `homedir()` fallback exists ONLY for running this plugin's own unit
 * tests outside a host process (where nobody published the var). It must never
 * be the path a real session uses.
 *
 * This helper is deliberately local to the plugin: an external plugin MUST NOT
 * import `@minimal-agent/plugin-api` or core `src/` at runtime. Each plugin
 * carries its own copy.
 *
 * @module lib/paths
 */

import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The agent's home directory — the base of all `~/.minimal-agent` storage.
 *
 * Honors `MINIMAL_AGENT_HOME` (trimmed) when set, else falls back to
 * `<fallbackHome>/.minimal-agent`. The `env` and `fallbackHome` params are
 * exposed for unit tests; production callers pass neither and get
 * `process.env` + the real `homedir()`.
 */
export function agentHome(
  env: NodeJS.ProcessEnv = process.env,
  fallbackHome: string = homedir(),
): string {
  return env.MINIMAL_AGENT_HOME?.trim() || join(fallbackHome, ".minimal-agent")
}
