/**
 * Paste plugin config.
 *
 * Source: `<agent home>/config.jsonc` (or `config.json`, or the path in
 * `MINIMAL_AGENT_CONFIG`), key path `plugins.paste` (the manifest id, S-1).
 *
 * ```jsonc
 * { "plugins": { "paste": { "collapse": { "minLines": 0, "minBytes": 0 } } } }
 * ```
 *
 * A paste becomes a ref when it has `minLines` lines or more, OR `minBytes`
 * bytes or more. The default `0/0` makes a ref for each non-empty paste (Q1).
 * Lenient: a missing file, bad JSONC or a wrong type gives the default. The
 * loader never throws.
 *
 * @module lib/config
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { resolveAgentHome } from "@minimal-agent/core/plugin-api/utils/agent-paths"
import { parseJsonc } from "@minimal-agent/core/plugin-api/utils/jsonc"

/** The collapse threshold. */
export interface CollapseConfig {
  /** Make a ref at this line count or more. */
  minLines: number
  /** Make a ref at this UTF-8 byte count or more. */
  minBytes: number
}

/** The plugin config. */
export interface PasteConfig {
  collapse: CollapseConfig
}

/** The built-in defaults: a ref for each non-empty paste. */
export function defaultPasteConfig(): PasteConfig {
  return { collapse: { minLines: 0, minBytes: 0 } }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined
}

/** Read `plugins.paste` from parsed config JSON. Bad fields keep the default. */
export function parsePasteConfig(raw: unknown): PasteConfig {
  const out = defaultPasteConfig()
  if (!isPlainObject(raw) || !isPlainObject(raw.plugins)) return out
  const cfg = raw.plugins.paste
  if (!isPlainObject(cfg) || !isPlainObject(cfg.collapse)) return out
  const minLines = count(cfg.collapse.minLines)
  const minBytes = count(cfg.collapse.minBytes)
  if (minLines !== undefined) out.collapse.minLines = minLines
  if (minBytes !== undefined) out.collapse.minBytes = minBytes
  return out
}

/** The config file path: `MINIMAL_AGENT_CONFIG`, else `config.jsonc`, else `config.json`. */
export function pasteConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MINIMAL_AGENT_CONFIG?.trim()
  if (explicit) return explicit
  const home = resolveAgentHome(env)
  const jsonc = join(home, "config.jsonc")
  return existsSync(jsonc) ? jsonc : join(home, "config.json")
}

/** Load the config. Always gives a valid config. */
export function loadPasteConfig(env: NodeJS.ProcessEnv = process.env): PasteConfig {
  try {
    const path = pasteConfigPath(env)
    if (!existsSync(path)) return defaultPasteConfig()
    return parsePasteConfig(parseJsonc(readFileSync(path, "utf-8")))
  } catch {
    return defaultPasteConfig()
  }
}

/**
 * True when the paste must become a ref. With `0/0` each paste collapses.
 * Otherwise the paste must reach one of the two limits that is not 0.
 */
export function shouldCollapse(c: CollapseConfig, lines: number, bytes: number): boolean {
  if (c.minLines === 0 && c.minBytes === 0) return true
  return (c.minLines > 0 && lines >= c.minLines) || (c.minBytes > 0 && bytes >= c.minBytes)
}
