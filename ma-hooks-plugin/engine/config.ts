/**
 * Plugin config reader.
 *
 * Source: `~/.minimal-agent/config.jsonc` (or `MINIMAL_AGENT_CONFIG`), key
 * `plugins["hooks"]`. Same convention as `ma-skills-plugin/lib/config.ts`.
 * The home comes from `resolveAgentHome(env)`, so a test that sets only
 * `HOME` (or `MINIMAL_AGENT_HOME`) reads its temp config. Lenient: any
 * error gives the defaults, never a throw.
 *
 * @module engine/config
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { resolveAgentHome } from "@minimal-agent/core/plugin-api/utils/agent-paths"
import { parseJsonc } from "@minimal-agent/core/plugin-api/utils/jsonc"

/** Parsed `plugins["hooks"]` block. */
export interface HooksConfig {
  enabled: boolean
  /** Per-adapter switch. Missing ids default to on. */
  adapters: Record<string, boolean>
  /** Adapter order after native. */
  adapterOrder: string[]
  stopBlockCap: number
  maxAsync: number
  outputCapChars: number
}

/** Plugin id used as the config key. */
export const PLUGIN_ID = "hooks"

/** Built-in defaults (SPEC.md "Switches"). */
export function defaultHooksConfig(): HooksConfig {
  return {
    enabled: true,
    adapters: { claude: true },
    adapterOrder: ["claude"],
    stopBlockCap: 8,
    maxAsync: 8,
    outputCapChars: 10_000,
  }
}

type Env = Readonly<Record<string, string | undefined>>

/** Resolve the config file path for `env`. */
export function hooksConfigPath(env: Env = process.env): string {
  const override = env.MINIMAL_AGENT_CONFIG?.trim()
  if (override) return override
  const dir = resolveAgentHome(env as NodeJS.ProcessEnv)
  const jsonc = join(dir, "config.jsonc")
  return existsSync(jsonc) ? jsonc : join(dir, "config.json")
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function posInt(v: unknown, min: number, max: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
    ? Math.floor(v)
    : undefined
}

/** Merge a parsed config document onto the defaults. Pure. */
export function parseHooksConfig(raw: unknown): HooksConfig {
  const out = defaultHooksConfig()
  if (!isObj(raw) || !isObj(raw.plugins)) return out
  const cfg = raw.plugins[PLUGIN_ID]
  if (!isObj(cfg)) return out
  if (typeof cfg.enabled === "boolean") out.enabled = cfg.enabled
  if (isObj(cfg.adapters)) {
    for (const [k, v] of Object.entries(cfg.adapters)) {
      if (typeof v === "boolean") out.adapters[k] = v
    }
  }
  if (Array.isArray(cfg.adapterOrder)) {
    out.adapterOrder = cfg.adapterOrder.filter(
      (s): s is string => typeof s === "string" && s !== "native",
    )
  }
  out.stopBlockCap = posInt(cfg.stopBlockCap, 1, 1000) ?? out.stopBlockCap
  out.maxAsync = posInt(cfg.maxAsync, 1, 256) ?? out.maxAsync
  out.outputCapChars = posInt(cfg.outputCapChars, 100, 10_000_000) ?? out.outputCapChars
  return out
}

/** Load the config for `env`. Defaults on any failure. */
export function loadHooksConfig(env: Env = process.env): HooksConfig {
  const path = hooksConfigPath(env)
  try {
    if (!existsSync(path)) return defaultHooksConfig()
    return parseHooksConfig(parseJsonc(readFileSync(path, "utf8")))
  } catch {
    return defaultHooksConfig()
  }
}
