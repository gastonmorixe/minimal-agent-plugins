/**
 * Plugin config loader for `agents-md`.
 *
 * Source: `~/.minimal-agent/config.jsonc` (or `MINIMAL_AGENT_CONFIG`),
 * key path: `plugins["agents-md"]` (also accepts legacy `plugins.agentsMd`
 * / `plugins["ma-agents-md"]` aliases).
 *
 * Lenient: missing file, missing section, malformed JSON, wrong types
 * → built-in defaults. Never throws — a misconfigured plugin must not
 * crash the agent at startup.
 *
 * Shape:
 *
 * ```jsonc
 * {
 *   "plugins": {
 *     "agents-md": {
 *       "enabled": true,          // host-level; also gates load
 *       "global": true,           // load <agent-home>/AGENTS.md
 *       "project": true,          // load <cwd>/AGENTS.md
 *       "maxBytes": 100000        // per-file cap (drop oversized)
 *     }
 *   }
 * }
 * ```
 *
 * Disable for a single run without touching config:
 *   `minimal-agent --no-agents-md`
 *   `minimal-agent --disable-plugin agents-md`
 *   `MINIMAL_AGENT_NO_AGENTS_MD=1`
 *
 * @module lib/config
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { agentHome } from "./agent-home.ts"
import { parseJsonc } from "./jsonc.ts"

/** Default per-file size cap (bytes). Keeps the system prompt bounded. */
export const DEFAULT_MAX_BYTES = 100_000

/**
 * Fully-defaulted config for the agents-md plugin. Callers never see
 * `undefined` fields after {@link loadAgentsMdConfig}.
 */
export interface AgentsMdConfig {
  /**
   * Load the user-global AGENTS.md from the resolved agent home
   * (`MINIMAL_AGENT_HOME` / `~/.minimal-agent/AGENTS.md`). Default true.
   */
  global: boolean
  /**
   * Load the project AGENTS.md from `<cwd>/AGENTS.md` (agents.md convention).
   * Default true.
   */
  project: boolean
  /**
   * Soft per-file size cap in bytes. Files larger than this are skipped
   * (with a diagnostic) rather than injected. Default {@link DEFAULT_MAX_BYTES}.
   */
  maxBytes: number
}

/** Built-in defaults when no user config is present. */
export const DEFAULT_AGENTS_MD_CONFIG: AgentsMdConfig = {
  global: true,
  project: true,
  maxBytes: DEFAULT_MAX_BYTES,
}

/** Config keys we accept under `plugins.<id>` (first match wins). */
const PLUGIN_KEYS = ["agents-md", "agentsMd", "ma-agents-md"] as const

/**
 * Load and fully default the agents-md config slice.
 *
 * Pure-ish: reads the config file once. Never throws. Optional `env`
 * injection supports tests and relocated homes (`MINIMAL_AGENT_HOME`,
 * `MINIMAL_AGENT_CONFIG`).
 */
export function loadAgentsMdConfig(env: NodeJS.ProcessEnv = process.env): AgentsMdConfig {
  const out: AgentsMdConfig = { ...DEFAULT_AGENTS_MD_CONFIG }
  const raw = readConfigObject(env)
  if (!raw) return out

  const plugins = raw.plugins
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
    return out
  }
  const pluginsObj = plugins as Record<string, unknown>

  let block: Record<string, unknown> | undefined
  for (const key of PLUGIN_KEYS) {
    const candidate = pluginsObj[key]
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      block = candidate as Record<string, unknown>
      break
    }
  }
  if (!block) return out

  if (typeof block.global === "boolean") out.global = block.global
  if (typeof block.project === "boolean") out.project = block.project
  if (typeof block.maxBytes === "number" && Number.isFinite(block.maxBytes) && block.maxBytes > 0) {
    out.maxBytes = Math.floor(block.maxBytes)
  }
  return out
}

/** Read the user config file as a plain object, or null on any failure. */
function readConfigObject(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  const path = resolveConfigPath(env)
  if (!path || !existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, "utf-8")
  } catch {
    return null
  }
  try {
    const parsed = parseJsonc(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Resolve the config path. `MINIMAL_AGENT_CONFIG` wins; otherwise prefer
 * `<agent-home>/config.jsonc` then `config.json`. Uses {@link agentHome}
 * so a relocated `MINIMAL_AGENT_HOME` is honored (never hardcodes
 * `~/.minimal-agent`).
 */
function resolveConfigPath(env: NodeJS.ProcessEnv): string | null {
  const override = env.MINIMAL_AGENT_CONFIG?.trim()
  if (override) return override
  const home = agentHome(env)
  const jsonc = join(home, "config.jsonc")
  if (existsSync(jsonc)) return jsonc
  const json = join(home, "config.json")
  if (existsSync(json)) return json
  return null
}
