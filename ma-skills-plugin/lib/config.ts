/**
 * Plugin config loader.
 *
 * Source: `~/.minimal-agent/config.jsonc` (or `MINIMAL_AGENT_CONFIG`),
 * key path: `plugins["ma-skills"]`.
 *
 * Lenient: missing file, missing section, malformed JSON, wrong types
 * → built-in defaults. Never throws — a misconfigured plugin must not
 * crash the agent at startup.
 *
 * Shape:
 *
 * ```jsonc
 *   {
 *     "plugins": {
 *       "ma-skills": {
 *         "enabled": true,
 *         "roots": {
 *           "project":            true,   // <cwd>/.agents/skills/
 *           "projectClaudeCode":  false,  // <cwd>/.claude/skills/  (interop, default off)
 *           "homeShared":         true,   // ~/.agents/skills/
 *           "userAgent":          true    // ~/.minimal-agent/skills/
 *         },
 *         "extraRoots":         [],
 *         "maxSkills":          64,
 *         "allowReservedNames": false     // permit `anthropic`/`claude` in names
 *       }
 *     }
 *   }
 * ```
 *
 * @module lib/config
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

import { parseJsonc } from "./jsonc.ts"

export type DiscoveryRootKey = "project" | "projectClaudeCode" | "homeShared" | "userAgent"

export interface RootsConfig {
  /** `<cwd>/.agents/skills/`. Default true. */
  project: boolean
  /** `<cwd>/.claude/skills/`. Claude Code interop. Default false. */
  projectClaudeCode: boolean
  /** `~/.agents/skills/`. Default true. */
  homeShared: boolean
  /** `~/.minimal-agent/skills/`. Default true. */
  userAgent: boolean
}

export interface SkillsConfig {
  /** When false, the loader skips the plugin entirely. */
  enabled: boolean
  /** Per-root opt-ins. */
  roots: RootsConfig
  /** Extra absolute paths to scan, lowest precedence. */
  extraRoots: string[]
  /** Cap on number of discovered skills; warn if exceeded. */
  maxSkills: number
  /** When true, allow `anthropic`/`claude` substring in skill names. */
  allowReservedNames: boolean
}

/** Built-in defaults. Pure — no IO. */
export function defaultConfig(): SkillsConfig {
  return {
    enabled: true,
    roots: {
      project: true,
      projectClaudeCode: false,
      homeShared: true,
      userAgent: true,
    },
    extraRoots: [],
    maxSkills: 64,
    allowReservedNames: false,
  }
}

/** Resolve the config file path. Mirrors `src/config.ts:configPath` in minimal-agent. */
export function configPath(): string {
  if (process.env.MINIMAL_AGENT_CONFIG) return process.env.MINIMAL_AGENT_CONFIG
  const dir = join(homedir(), ".minimal-agent")
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

/**
 * Validate + normalize a `plugins["ma-skills"]` block. Unknown / wrong-type
 * fields are dropped silently. Valid fields override defaults.
 *
 * Pure: takes parsed JSON, returns the merged config. Exposed for tests.
 */
export function parseSkillsConfig(raw: unknown): SkillsConfig {
  const out = defaultConfig()
  if (!isPlainObject(raw)) return out
  const plugins = raw.plugins
  if (!isPlainObject(plugins)) return out
  const cfg = plugins["ma-skills"]
  if (!isPlainObject(cfg)) return out

  if (typeof cfg.enabled === "boolean") out.enabled = cfg.enabled

  if (isPlainObject(cfg.roots)) {
    const r = cfg.roots
    if (typeof r.project === "boolean") out.roots.project = r.project
    if (typeof r.projectClaudeCode === "boolean") out.roots.projectClaudeCode = r.projectClaudeCode
    if (typeof r.homeShared === "boolean") out.roots.homeShared = r.homeShared
    if (typeof r.userAgent === "boolean") out.roots.userAgent = r.userAgent
  }

  if (Array.isArray(cfg.extraRoots)) {
    const ex: string[] = []
    for (const v of cfg.extraRoots) {
      if (typeof v !== "string") continue
      const s = v.trim()
      if (s.length === 0) continue
      // Only accept absolute paths. Relative paths against `cwd` are too
      // surprising for a config that loads at agent startup.
      if (!isAbsolute(s)) continue
      ex.push(s)
    }
    out.extraRoots = ex
  }

  if (
    typeof cfg.maxSkills === "number" &&
    Number.isFinite(cfg.maxSkills) &&
    cfg.maxSkills >= 1 &&
    cfg.maxSkills <= 10_000
  ) {
    out.maxSkills = Math.floor(cfg.maxSkills)
  }

  if (typeof cfg.allowReservedNames === "boolean") {
    out.allowReservedNames = cfg.allowReservedNames
  }

  return out
}

/**
 * Load + parse user config. Always returns a valid {@link SkillsConfig} —
 * built-in defaults on any failure. Use {@link defaultConfig} directly to
 * skip disk IO (tests).
 */
export function loadSkillsConfig(): SkillsConfig {
  const path = configPath()
  const raw = readRaw(path)
  if (raw === null) return defaultConfig()
  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
  } catch (err) {
    if (process.env.DEBUG === "1") {
      process.stderr.write(`[ma-skills] ${path}: parse error: ${(err as Error).message}\n`)
    }
    return defaultConfig()
  }
  return parseSkillsConfig(parsed)
}
