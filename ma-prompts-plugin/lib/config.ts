/**
 * Plugin config loader.
 *
 * Source: `~/.minimal-agent/config.jsonc` (or `MINIMAL_AGENT_CONFIG`),
 * key path: `plugins["ma-prompts"]`.
 *
 * Lenient: missing file, missing section, malformed JSON, wrong types
 * fall back to built-in defaults. Never throws, so a misconfigured plugin
 * cannot crash the agent at startup.
 *
 * @module lib/config
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { agentHome } from "./agent-home.ts"
import { parseJsonc } from "./jsonc.ts"
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_PROMPTS } from "./store.ts"

export interface PromptsConfig {
  /** When false, the plugin is inert: no menu, no expansion, tools error. */
  enabled: boolean
  /** Also scan `<cwd>/.agents/prompts/`. Project prompts shadow user ones. */
  projectScope: boolean
  /** Max body bytes accepted by PromptNew / PromptEdit. */
  maxBodyBytes: number
  /** Max prompts in the library. */
  maxPrompts: number
  /** Sigil for the menu. Changing it is advanced; the default is `&`. */
  sigil: string
}

/** Built-in defaults. Pure, no IO. */
export function defaultConfig(): PromptsConfig {
  return {
    enabled: true,
    projectScope: false,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    maxPrompts: DEFAULT_MAX_PROMPTS,
    sigil: "&",
  }
}

/** Resolve the config file path. Mirrors core's `configPath`. */
export function configPath(): string {
  if (process.env.MINIMAL_AGENT_CONFIG) return process.env.MINIMAL_AGENT_CONFIG
  const dir = agentHome()
  const jsoncPath = join(dir, "config.jsonc")
  if (existsSync(jsoncPath)) return jsoncPath
  return join(dir, "config.json")
}

function readRaw(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return null
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/** Validate + normalize a `plugins["ma-prompts"]` block. Pure; for tests. */
export function parsePromptsConfig(raw: unknown): PromptsConfig {
  const out = defaultConfig()
  if (!isPlainObject(raw)) return out
  const plugins = raw.plugins
  if (!isPlainObject(plugins)) return out
  const cfg = plugins["ma-prompts"]
  if (!isPlainObject(cfg)) return out

  if (typeof cfg.enabled === "boolean") out.enabled = cfg.enabled
  if (typeof cfg.projectScope === "boolean") out.projectScope = cfg.projectScope

  if (
    typeof cfg.maxBodyBytes === "number" &&
    Number.isFinite(cfg.maxBodyBytes) &&
    cfg.maxBodyBytes >= 1
  ) {
    out.maxBodyBytes = Math.floor(cfg.maxBodyBytes)
  }
  if (
    typeof cfg.maxPrompts === "number" &&
    Number.isFinite(cfg.maxPrompts) &&
    cfg.maxPrompts >= 1
  ) {
    out.maxPrompts = Math.floor(cfg.maxPrompts)
  }
  if (typeof cfg.sigil === "string" && cfg.sigil.trim().length === 1) {
    out.sigil = cfg.sigil.trim()
  }

  return out
}

/** Load + parse user config. Always returns a valid config. */
export function loadPromptsConfig(): PromptsConfig {
  const path = configPath()
  const raw = readRaw(path)
  if (raw === null) return defaultConfig()
  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
  } catch {
    return defaultConfig()
  }
  return parsePromptsConfig(parsed)
}
