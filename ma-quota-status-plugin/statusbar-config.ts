/**
 * Read the user's `statusBar` config slice WITHOUT importing core `src/config`.
 *
 * quota-status only needs `statusBar.segments` (segment order/visibility) and
 * `statusBar.script` (full-custom renderer command). An external plugin can't
 * import core's `loadUserConfig`, so it re-derives just this slice from the
 * same rules: resolve the config path (honor MINIMAL_AGENT_CONFIG, else
 * `~/.minimal-agent/config.jsonc`, else `.../config.json`), parse it as JSONC,
 * and shape-check the `statusBar` block. Everything else in the config is
 * ignored. Lenient: any read/parse failure yields an empty slice, never throws.
 *
 * @module quota-status/statusbar-config
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { parseJsonc } from "./lib/jsonc.ts"

/** The `statusBar` slice quota-status consumes. */
export interface StatusBarConfig {
  segments?: string[]
  script?: string
}

/**
 * The agent home dir. Honors `MINIMAL_AGENT_HOME` (trimmed) when set, else
 * `<home>/.minimal-agent`. Mirror of core `resolveAgentHome`.
 */
function agentHome(env: NodeJS.ProcessEnv = process.env, fallbackHome: string = homedir()): string {
  return env.MINIMAL_AGENT_HOME?.trim() || join(fallbackHome, ".minimal-agent")
}

/** Resolve the user config path. Mirror of core `configPath()`. */
function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MINIMAL_AGENT_CONFIG
  if (override) return override
  const dir = agentHome(env)
  const jsoncPath = join(dir, "config.jsonc")
  if (existsSync(jsoncPath)) return jsoncPath
  return join(dir, "config.json")
}

/**
 * Read the `statusBar` config slice. Returns `{}` on any missing-file / parse
 * / shape failure. Segments must be a non-empty string[]; script a non-empty
 * string. Matches the shape-check in core `loadUserConfig`.
 */
export function loadStatusBarConfig(env: NodeJS.ProcessEnv = process.env): StatusBarConfig {
  const path = configPath(env)
  if (!existsSync(path)) return {}
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const sb = (parsed as Record<string, unknown>).statusBar
  if (!sb || typeof sb !== "object" || Array.isArray(sb)) return {}
  const block = sb as Record<string, unknown>
  const out: StatusBarConfig = {}
  if (Array.isArray(block.segments)) {
    const segs = block.segments.filter((s): s is string => typeof s === "string")
    if (segs.length > 0) out.segments = segs
  }
  if (typeof block.script === "string" && block.script.length > 0) {
    out.script = block.script
  }
  return out
}
