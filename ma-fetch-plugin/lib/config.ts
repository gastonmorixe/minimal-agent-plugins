/**
 * Plugin config loader.
 *
 * Source: `~/.minimal-agent/config.jsonc` (or `MINIMAL_AGENT_CONFIG`),
 * key path: `plugins["ma-fetch"]`.
 *
 * Lenient: missing file, missing section, malformed JSON, wrong types
 * → built-in defaults. Never throws - a misconfigured plugin must not
 * crash the agent at startup. Runtime errors are the handler's job.
 *
 * Shape:
 *
 *   {
 *     "plugins": {
 *       "ma-fetch": {
 *         "enabled": true,                // default true
 *         "backend": "obscura",           // backend script name (in backends/<name>.ts)
 *         "userAgent": null,              // optional UA override (plugin-wide)
 *         "proxy": null,                  // optional proxy URL  (plugin-wide)
 *         "obscura": {                    // per-backend config
 *           "bin": "/Users/.../obscura"   // path to obscura binary (else `obscura` on PATH)
 *         },
 *         "defaults": {                   // per-call defaults
 *           "format": "markdown",
 *           "waitUntil": "domcontentloaded",
 *           "timeoutSec": 30
 *         }
 *       }
 *     }
 *   }
 *
 * @module lib/config
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { CleanupLevel } from "./cleanup.ts"
import { CLEANUP_LEVELS } from "./cleanup.ts"
import { parseJsonc } from "./jsonc.ts"

export type FetchFormat = "markdown" | "text" | "html" | "links" | "original"
export type WaitUntil = "load" | "domcontentloaded" | "networkidle0"

export interface FetchDefaults {
  format: FetchFormat
  waitUntil: WaitUntil
  timeoutSec: number
  /** Default whitespace cleanup level for `markdown`/`text` output.
   *  Overridden per-call by the tool's `cleanup` param. See `lib/cleanup.ts`
   *  for the level semantics. */
  cleanup: CleanupLevel
}

export interface BackendConfig {
  /** Absolute path to the backend's binary. When unset, the backend script
   *  falls back to its default (e.g. `obscura` on PATH). */
  bin?: string
  /** Optional list of WebExtension bundle paths (`.crx`, `.xpi`, `.zip`, or
   *  unpacked dir). Obscura-specific today: forwarded as `--extension <PATH>`
   *  per entry. Other backends ignore this field. Obscura currently honors
   *  only the FIRST extension and warns on extras (multi-extension support
   *  is on the roadmap). */
  extensions?: string[]
}

export interface FetchConfig {
  /** When `false`, the loader skips the plugin entirely. */
  enabled: boolean
  /** Backend script name (resolves to `backends/<backend>.ts`). */
  backend: string
  /** Optional UA override applied by the backend (not exposed to the model). */
  userAgent: string | null
  /** Optional proxy applied by the backend (not exposed to the model). */
  proxy: string | null
  /** Per-backend config blocks keyed by backend id. */
  backends: Record<string, BackendConfig>
  /** Per-call defaults, overridden by tool input. */
  defaults: FetchDefaults
}

const VALID_FORMATS = new Set<FetchFormat>(["markdown", "text", "html", "links", "original"])
const VALID_WAIT_UNTIL = new Set<WaitUntil>(["load", "domcontentloaded", "networkidle0"])
const VALID_CLEANUP = new Set<CleanupLevel>(CLEANUP_LEVELS)

/** Built-in defaults. Pure - no IO.
 *
 * `waitUntil` defaults to `domcontentloaded`, not `load`. Empirically, on
 * stealth-protected article sites (Schwab, SoFi, etc.) waiting for the
 * full `load` event races with anti-bot redirects and post-parse DOM
 * rewrites, and ends up capturing a nav-only shell. `domcontentloaded`
 * captures the SSR'd initial DOM, which is where article content actually
 * lives. `load` and `networkidle0` are still available as explicit
 * overrides (`load` for asset-completeness, `networkidle0` for SPA shells
 * that fetch their content after the initial paint).
 */
export function defaultConfig(): FetchConfig {
  return {
    enabled: true,
    backend: "obscura",
    userAgent: null,
    proxy: null,
    backends: {},
    defaults: {
      format: "markdown",
      waitUntil: "domcontentloaded",
      timeoutSec: 30,
      cleanup: "basic",
    },
  }
}

/** Resolve config file path. Mirrors `src/config.ts:configPath` in minimal-agent. */
export function configPath(): string {
  if (process.env.MINIMAL_AGENT_CONFIG) return process.env.MINIMAL_AGENT_CONFIG
  const dir = join(homedir(), ".minimal-agent")
  const jsoncPath = join(dir, "config.jsonc")
  if (existsSync(jsoncPath)) return jsoncPath
  return join(dir, "config.json")
}

/** Read raw file text; `null` on any failure. */
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
 * Validate and normalize a `plugins["ma-fetch"]` block. Unknown/wrong-type
 * fields are dropped silently. Valid fields override defaults.
 *
 * Pure: takes parsed JSON, returns the merged config. Exposed for tests.
 */
export function parseFetchConfig(raw: unknown): FetchConfig {
  const out = defaultConfig()
  if (!isPlainObject(raw)) return out
  const plugins = raw.plugins
  if (!isPlainObject(plugins)) return out
  const cfg = plugins["ma-fetch"]
  if (!isPlainObject(cfg)) return out

  if (typeof cfg.enabled === "boolean") out.enabled = cfg.enabled

  if (typeof cfg.backend === "string" && cfg.backend.trim().length > 0) {
    // Lock down to ascii-safe identifier shape so we can never path-traverse
    // when joining with `backends/<name>.ts`.
    const id = cfg.backend.trim()
    if (/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
      out.backend = id
    }
  }

  if (typeof cfg.userAgent === "string" && cfg.userAgent.trim().length > 0) {
    out.userAgent = cfg.userAgent.trim()
  }

  if (typeof cfg.proxy === "string" && cfg.proxy.trim().length > 0) {
    out.proxy = cfg.proxy.trim()
  }

  if (isPlainObject(cfg.defaults)) {
    const d = cfg.defaults
    if (typeof d.format === "string" && VALID_FORMATS.has(d.format as FetchFormat)) {
      out.defaults.format = d.format as FetchFormat
    }
    if (typeof d.waitUntil === "string" && VALID_WAIT_UNTIL.has(d.waitUntil as WaitUntil)) {
      out.defaults.waitUntil = d.waitUntil as WaitUntil
    }
    if (typeof d.timeoutSec === "number" && d.timeoutSec >= 1 && d.timeoutSec <= 600) {
      out.defaults.timeoutSec = Math.floor(d.timeoutSec)
    }
    if (typeof d.cleanup === "string" && VALID_CLEANUP.has(d.cleanup as CleanupLevel)) {
      out.defaults.cleanup = d.cleanup as CleanupLevel
    }
  }

  // Per-backend blocks: any object-valued key under cfg (other than known
  // top-level keys) is treated as a backend config block. Currently the
  // only field we look at inside one is `bin`.
  const knownTop = new Set(["enabled", "backend", "userAgent", "proxy", "defaults"])
  const backends: Record<string, BackendConfig> = {}
  for (const [k, v] of Object.entries(cfg)) {
    if (knownTop.has(k)) continue
    if (!isPlainObject(v)) continue
    const block: BackendConfig = {}
    if (typeof v.bin === "string" && v.bin.trim().length > 0) {
      block.bin = v.bin.trim()
    }
    if (Array.isArray(v.extensions)) {
      const exts = v.extensions
        .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
        .map((e) => e.trim())
      if (exts.length > 0) block.extensions = exts
    }
    backends[k] = block
  }
  out.backends = backends

  return out
}

/**
 * Load + parse user config. Always returns a valid `FetchConfig` - built-in
 * defaults on any failure. Use `defaultConfig()` directly to skip disk IO
 * (tests, CLI use cases).
 */
export function loadFetchConfig(): FetchConfig {
  const path = configPath()
  const raw = readRaw(path)
  if (raw === null) return defaultConfig()
  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
  } catch (err) {
    if (process.env.DEBUG === "1") {
      process.stderr.write(`[ma-fetch] ${path}: parse error: ${(err as Error).message}\n`)
    }
    return defaultConfig()
  }
  return parseFetchConfig(parsed)
}
