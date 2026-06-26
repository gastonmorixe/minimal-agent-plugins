/**
 * Agent home resolution. Pure path math, no IO.
 *
 * Every `~/.minimal-agent` path this plugin touches (the user skills root, the
 * token cache) must honor the host's relocation signal. minimal-agent resolves
 * its real home at boot and PUBLISHES it into `process.env.MINIMAL_AGENT_HOME`
 * (see core's `src/agent-paths.ts: publishAgentHomeEnv`), which the loader
 * threads into every plugin context's `env`. So in a live agent this env var is
 * set and authoritative — we never hardcode `~/.minimal-agent` when the host
 * may have moved it.
 *
 * The `fallbackHome` param exists ONLY for running this plugin's own unit tests
 * outside a host process (where nobody published the var) and for honoring a
 * caller's already-resolved OS home. Callers that pass an OS home (e.g.
 * `defaultRoots(cwd, home)`) thread it through here as the fallback so existing
 * injected-home tests keep working while a relocation still wins.
 *
 * IMPORTANT: this is only for the `~/.minimal-agent` convention. The sibling
 * `~/.agents` convention is a DIFFERENT root and must NOT route through here.
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
 * exposed for callers that already resolved an OS home and for unit tests.
 */
export function agentHome(
  env: NodeJS.ProcessEnv = process.env,
  fallbackHome: string = homedir(),
): string {
  return env.MINIMAL_AGENT_HOME?.trim() || join(fallbackHome, ".minimal-agent")
}
