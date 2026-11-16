/**
 * Operator options for this provider's wire (env + config file).
 *
 * Source: `~/.minimal-agent/config.jsonc` (or `MINIMAL_AGENT_CONFIG`; the home
 * honors `MINIMAL_AGENT_HOME`), key path `plugins.anthropic` (the plugin id in
 * ./provider.json). Same lenient read as the other plugins' config loaders:
 * a missing file, a malformed file or a wrong type falls back to the default.
 * The env var always wins over the config file.
 *
 * ```jsonc
 * {
 *   "plugins": {
 *     "anthropic": {
 *       // false = do not send body metadata.user_id on OAuth requests.
 *       // Env equivalent: MINIMAL_AGENT_NO_METADATA_USER_ID=1
 *       "metadataUserId": true,
 *       // "updates" = send thinking {type:"adaptive",display:"updates"} plus
 *       // the thinking-display-updates-2026-08-18 beta (CC 2.1.325 parity).
 *       // Default: unset (thinking text stays visible).
 *       // Env equivalent: MINIMAL_AGENT_THINKING_DISPLAY=updates
 *       "thinkingDisplay": "updates"
 *     }
 *   }
 * }
 * ```
 *
 * This plugin exposes no CLI flags, so there is no CLI-arg path.
 *
 * @module llm/providers/anthropic/wire-options
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { resolveAgentHome } from "@minimal-agent/core/plugin-api/utils/agent-paths"
import { parseJsonc } from "@minimal-agent/core/plugin-api/utils/jsonc"

/** Resolved `plugins.anthropic` options. */
export interface AnthropicWireOptions {
  /** Send body `metadata.user_id` on OAuth requests (default true). */
  metadataUserId: boolean
  /** `"updates"` opts into thinking.display "updates"; undefined = default. */
  thinkingDisplay?: "updates"
}

const DEFAULTS: AnthropicWireOptions = { metadataUserId: true }

let cached: { path: string; options: AnthropicWireOptions } | undefined

/** Resolved config path, computed once per process (reset by the test seam). */
let cachedPath: string | undefined

/**
 * Config file path: `MINIMAL_AGENT_CONFIG`, else `<home>/config.jsonc|json`.
 * Resolved once per process, so a request does not stat the home each time.
 */
function configPath(): string {
  if (cachedPath !== undefined) return cachedPath
  if (process.env.MINIMAL_AGENT_CONFIG) {
    cachedPath = process.env.MINIMAL_AGENT_CONFIG
  } else {
    const home = resolveAgentHome()
    const jsonc = join(home, "config.jsonc")
    cachedPath = existsSync(jsonc) ? jsonc : join(home, "config.json")
  }
  return cachedPath
}

/** Pure: resolve a parsed config object. Exposed for tests. */
export function resolveWireOptions(raw: unknown): AnthropicWireOptions {
  const out = { ...DEFAULTS }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out
  const plugins = (raw as Record<string, unknown>).plugins
  if (!plugins || typeof plugins !== "object") return out
  const cfg = (plugins as Record<string, unknown>).anthropic
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return out
  const c = cfg as Record<string, unknown>
  if (typeof c.metadataUserId === "boolean") out.metadataUserId = c.metadataUserId
  if (c.thinkingDisplay === "updates") out.thinkingDisplay = "updates"
  return out
}

/** Read the config file once per path (cached for the process). */
function fileOptions(): AnthropicWireOptions {
  const path = configPath()
  if (cached?.path === path) return cached.options
  let options = { ...DEFAULTS }
  try {
    if (existsSync(path)) options = resolveWireOptions(parseJsonc(readFileSync(path, "utf8")))
  } catch {
    // Malformed config: keep defaults (never break a request over config).
  }
  cached = { path, options }
  return options
}

/** Test seam: forget the cached config path and config read. */
export function _resetWireOptionsForTest(): void {
  cached = undefined
  cachedPath = undefined
}

/**
 * Whether OAuth requests carry body `metadata.user_id`. Off when
 * `MINIMAL_AGENT_NO_METADATA_USER_ID=1` or `plugins.anthropic.metadataUserId`
 * is `false`.
 */
export function metadataUserIdEnabled(): boolean {
  if (process.env.MINIMAL_AGENT_NO_METADATA_USER_ID === "1") return false
  return fileOptions().metadataUserId
}

/**
 * Whether to request thinking.display "updates". Opt-in only:
 * `MINIMAL_AGENT_THINKING_DISPLAY=updates` or
 * `plugins.anthropic.thinkingDisplay: "updates"`. Any other env value
 * (e.g. "default") forces the default even when the config opts in.
 */
export function thinkingDisplayUpdatesEnabled(): boolean {
  const env = process.env.MINIMAL_AGENT_THINKING_DISPLAY
  if (env !== undefined && env !== "") return env === "updates"
  return fileOptions().thinkingDisplay === "updates"
}
