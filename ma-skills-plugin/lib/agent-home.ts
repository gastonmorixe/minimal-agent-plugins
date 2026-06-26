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
 * @module lib/agent-home
 */

import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The agent home, honoring `MINIMAL_AGENT_HOME` (published by the host at
 * boot). When the env var is set (and non-blank) it wins; otherwise we fall
 * back to `<fallbackHome>/.minimal-agent`.
 *
 * The `fallbackHome` param exists so callers that already thread an injected
 * `home` (e.g. discovery's test-driven `home` param) preserve their existing
 * semantics: a relocated `MINIMAL_AGENT_HOME` wins, but absent the override the
 * result is exactly `join(fallbackHome, ".minimal-agent")` as before. It
 * defaults to the OS home directory for callers (config loading, unit tests
 * outside a host) that don't inject one.
 */
export function agentHome(
  env: NodeJS.ProcessEnv = process.env,
  fallbackHome: string = homedir(),
): string {
  return env.MINIMAL_AGENT_HOME?.trim() || join(fallbackHome, ".minimal-agent")
}
