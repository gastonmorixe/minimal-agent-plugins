/**
 * The agent home directory, honoring `MINIMAL_AGENT_HOME`.
 *
 * The host resolves its real home at boot and PUBLISHES it into
 * `process.env.MINIMAL_AGENT_HOME`, which the loader threads into every
 * plugin context's `env`. In a live agent this var is always set and
 * authoritative, so we never hardcode a location the host may have relocated.
 *
 * Tiny local helper on purpose: external plugins must NOT import
 * `@minimal-agent/plugin-api` or core `src/` at runtime.
 *
 * @module lib/agent-home
 */

import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The agent home, honoring `MINIMAL_AGENT_HOME`.
 *
 * Precedence: a non-blank `MINIMAL_AGENT_HOME` wins, then
 * `<fallbackHome>/.minimal-agent`, then `$HOME/.minimal-agent`, then
 * `os.homedir()/.minimal-agent`.
 *
 * `env.HOME` is consulted BEFORE `homedir()` on purpose. `homedir()` reads the
 * OS user database and ignores an overridden `HOME`, so without this order a
 * test (or a user) that relocates `HOME` would still write to the real home.
 */
export function agentHome(
  env: NodeJS.ProcessEnv | Record<string, string> = process.env,
  fallbackHome?: string,
): string {
  const raw = env.MINIMAL_AGENT_HOME
  const trimmed = typeof raw === "string" ? raw.trim() : ""
  if (trimmed) return trimmed
  const home = fallbackHome || (typeof env.HOME === "string" ? env.HOME : "") || homedir()
  return join(home, ".minimal-agent")
}
