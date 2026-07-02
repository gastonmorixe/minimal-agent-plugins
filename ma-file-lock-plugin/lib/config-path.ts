/**
 * Resolve the path to the user's minimal-agent config file.
 *
 * Local copy of the host's `configPath()` (core `src/config.ts`). An external
 * plugin can't import core or `@minimal-agent/plugin-api`, so it re-derives the
 * path from the same rules: honor `MINIMAL_AGENT_CONFIG`, else
 * `~/.minimal-agent/config.jsonc` when it exists, else `.../config.json`. The
 * agent-home resolution honors `MINIMAL_AGENT_HOME` (published by the host at
 * boot), matching the local `agentHome` idiom in the other ma-* plugins.
 *
 * @module lib/config-path
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The agent's home directory. Honors `MINIMAL_AGENT_HOME` (trimmed) when set,
 * else `<home>/.minimal-agent`. Mirror of the host's `resolveAgentHome`.
 */
export function agentHome(
  env: NodeJS.ProcessEnv = process.env,
  fallbackHome: string = homedir(),
): string {
  return env.MINIMAL_AGENT_HOME?.trim() || join(fallbackHome, ".minimal-agent")
}

/**
 * The user config path. Mirrors core `configPath()` so the file-lock plugin
 * reads the same `plugins["file-lock"].staleAfterMs` the host would.
 */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MINIMAL_AGENT_CONFIG
  if (override) return override
  const dir = agentHome(env)
  const jsoncPath = join(dir, "config.jsonc")
  if (existsSync(jsoncPath)) return jsoncPath
  return join(dir, "config.json")
}
