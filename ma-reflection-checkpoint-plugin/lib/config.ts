/**
 * Config of the reflection checkpoint plugin.
 *
 * Sources, last wins:
 *
 * 1. Built-in defaults: `interval` 50, `cooldownMs` 60000.
 * 2. `plugins["reflection-checkpoint"]` in the user config file
 *    (`MINIMAL_AGENT_CONFIG`, else `<agent-home>/config.jsonc`, else
 *    `<agent-home>/config.json`).
 * 3. The env vars `MINIMAL_AGENT_REFLECTION_INTERVAL` and
 *    `MINIMAL_AGENT_REFLECTION_COOLDOWN_MS`.
 *
 * `interval` 0 turns the checkpoints off. `cooldownMs` 0 keeps the
 * attachment and does not wait. A value that is not a finite number of 0 or
 * more is ignored. This module never throws: a bad config gives the defaults.
 *
 * @module lib/config
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { parseJsonc } from "./jsonc.ts"

/** The plugin id, and the key of its block under `plugins` in the config. */
export const PLUGIN_ID = "reflection-checkpoint"

/** Default number of tool rounds between two checkpoints. */
export const DEFAULT_INTERVAL = 50

/** Default cooldown in milliseconds before a checkpoint attachment. */
export const DEFAULT_COOLDOWN_MS = 60_000

/** The env var that sets the interval. */
export const ENV_INTERVAL = "MINIMAL_AGENT_REFLECTION_INTERVAL"

/** The env var that sets the cooldown. */
export const ENV_COOLDOWN_MS = "MINIMAL_AGENT_REFLECTION_COOLDOWN_MS"

/** The resolved config. */
export interface ReflectionConfig {
  /** Tool rounds between checkpoints. 0 means off. */
  interval: number
  /** Wait before the attachment, in milliseconds. 0 means no wait. */
  cooldownMs: number
}

/** A floored non-negative number from `v`, or `undefined`. */
function nonNegative(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

/** The agent home: `MINIMAL_AGENT_HOME`, else `$HOME/.minimal-agent`. */
function agentHome(env: Record<string, string | undefined>): string {
  const override = env.MINIMAL_AGENT_HOME?.trim()
  if (override) return override
  const home = env.HOME?.trim()
  return join(home || homedir(), ".minimal-agent")
}

/** The config file path, or `null` when there is no file. */
function configPath(env: Record<string, string | undefined>): string | null {
  const override = env.MINIMAL_AGENT_CONFIG?.trim()
  if (override) return override
  const home = agentHome(env)
  for (const name of ["config.jsonc", "config.json"]) {
    const p = join(home, name)
    if (existsSync(p)) return p
  }
  return null
}

/** The `plugins["reflection-checkpoint"]` block, or `null`. */
function readPluginBlock(env: Record<string, string | undefined>): Record<string, unknown> | null {
  const path = configPath(env)
  if (!path || !existsSync(path)) return null
  try {
    const raw = parseJsonc(readFileSync(path, "utf-8")) as { plugins?: unknown } | null
    const plugins = raw?.plugins
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return null
    const block = (plugins as Record<string, unknown>)[PLUGIN_ID]
    if (!block || typeof block !== "object" || Array.isArray(block)) return null
    return block as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Resolve the config from the defaults, the config file and the env.
 *
 * @param env - The env to read (the handler `ctx.env`, or `process.env`).
 * @returns The resolved config.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): ReflectionConfig {
  const out: ReflectionConfig = { interval: DEFAULT_INTERVAL, cooldownMs: DEFAULT_COOLDOWN_MS }
  const block = readPluginBlock(env)
  if (block) {
    out.interval = nonNegative(block.interval) ?? out.interval
    out.cooldownMs = nonNegative(block.cooldownMs) ?? out.cooldownMs
  }
  out.interval = nonNegative(env[ENV_INTERVAL]) ?? out.interval
  out.cooldownMs = nonNegative(env[ENV_COOLDOWN_MS]) ?? out.cooldownMs
  return out
}
