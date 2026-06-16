/**
 * Plugin config loader.
 *
 * Source: `~/.minimal-agent/config.jsonc` (or `MINIMAL_AGENT_CONFIG`),
 * key path: `plugins["ma-speak"]`.
 *
 * Lenient: missing file, missing section, malformed JSON, wrong types
 * → built-in defaults. Never throws - a misconfigured plugin must not
 * crash the agent at startup. Runtime errors are the handler's job.
 *
 * Shape:
 *
 * ```jsonc
 *   {
 *     "plugins": {
 *       "ma-speak": {
 *         "enabled": true,                // default true
 *         "backend": "macos-say",         // backend script name (in backends/<name>.ts)
 *         "macos-say": {                  // per-backend config block
 *           "bin": "/usr/bin/say",        // optional path to the speech binary
 *           "rate": 180                   // optional words-per-minute (backend-specific)
 *           // "voice" is optional and best left UNSET — see note below.
 *         },
 *         "defaults": {                   // plugin-wide knobs (NOT model-facing)
 *           "maxChars": 8000,             // hard cap on a single utterance
 *           "waitTimeoutSec": 120         // cap for a blocking `wait: true` call
 *         }
 *       }
 *     }
 *   }
 * ```
 *
 * Voice, rate, and binary path are deliberately config-only: the model
 * controls *what* is said, never *how* it sounds. That keeps the tool
 * backend-agnostic.
 *
 * On `voice`: leaving it unset is the better default. With no `-v` flag, the
 * macOS `say` backend uses the system default voice — the Premium / Enhanced
 * Siri neural voice chosen in System Settings. The named voices from
 * `say -v '?'` are the older, lower-quality ones, and the Premium voices can't
 * be addressed by name, so setting `voice` downgrades the audio.
 *
 * @module lib/config
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { parseJsonc } from "./jsonc.ts"

/** Plugin-wide defaults. None of these are exposed as tool parameters. */
export interface SpeakDefaults {
  /** Hard cap on the length of a single utterance, in characters. Text
   *  longer than this is rejected by the handler before it reaches a
   *  backend. Guards against the model dumping a whole file into `say`. */
  maxChars: number
  /** Upper bound (seconds) for a blocking `wait: true` call. If speech
   *  runs longer, the handler stops waiting and returns, leaving the job
   *  playing in the background. Prevents a long utterance from stalling
   *  the agent turn indefinitely. */
  waitTimeoutSec: number
}

/** Per-backend config block. Fields are a superset across backends; a
 *  given backend reads only the ones it understands and ignores the rest. */
export interface BackendConfig {
  /** Absolute path to the speech binary. When unset, the backend falls
   *  back to its built-in default (e.g. `say` on PATH). */
  bin?: string
  /** Voice name passed to the backend (e.g. `Samantha`). Backend-specific; the
   *  macOS backend forwards it as `say -v <voice>`. Best left UNSET: with no
   *  voice, `say` uses the system default (a Premium Siri neural voice), which
   *  sounds better than any name-addressable voice. Setting this downgrades. */
  voice?: string
  /** Speech rate in words per minute. The macOS backend forwards it as
   *  `say -r <rate>`. Backends that don't support a rate ignore it. */
  rate?: number
}

export interface SpeakConfig {
  /** When `false`, the plugin refuses to speak (handler returns an error). */
  enabled: boolean
  /** Backend script name (resolves to `backends/<backend>.ts`). */
  backend: string
  /** Per-backend config blocks keyed by backend id. */
  backends: Record<string, BackendConfig>
  /** Plugin-wide defaults, not overridable per tool-call. */
  defaults: SpeakDefaults
}

/** Absolute floor/ceiling for `maxChars` so a wild config value can't make
 *  the cap useless (0) or unbounded. */
export const MAX_CHARS_FLOOR = 1
export const MAX_CHARS_CEILING = 200_000
/** Default single-utterance cap, in characters. Matches the manifest schema. */
export const DEFAULT_MAX_CHARS = 8000
/** Default blocking-wait cap, in seconds. */
export const DEFAULT_WAIT_TIMEOUT_SEC = 120
/** Floor/ceiling for `waitTimeoutSec`. */
export const WAIT_TIMEOUT_FLOOR_SEC = 1
export const WAIT_TIMEOUT_CEILING_SEC = 1800

/** Same id shape the manifest enforces elsewhere: a safe ascii identifier
 *  so joining `backends/<name>.ts` can never path-traverse. */
export const BACKEND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i

/** Built-in defaults. Pure - no IO. */
export function defaultConfig(): SpeakConfig {
  return {
    enabled: true,
    backend: "macos-say",
    backends: {},
    defaults: {
      maxChars: DEFAULT_MAX_CHARS,
      waitTimeoutSec: DEFAULT_WAIT_TIMEOUT_SEC,
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Validate and normalize a `plugins["ma-speak"]` block. Unknown / wrong-type
 * fields are dropped silently. Valid fields override defaults.
 *
 * Pure: takes parsed JSON, returns the merged config. Exposed for tests.
 */
export function parseSpeakConfig(raw: unknown): SpeakConfig {
  const out = defaultConfig()
  if (!isPlainObject(raw)) return out
  const plugins = raw.plugins
  if (!isPlainObject(plugins)) return out
  const cfg = plugins["ma-speak"]
  if (!isPlainObject(cfg)) return out

  if (typeof cfg.enabled === "boolean") out.enabled = cfg.enabled

  if (typeof cfg.backend === "string" && cfg.backend.trim().length > 0) {
    const id = cfg.backend.trim()
    if (BACKEND_NAME_PATTERN.test(id)) out.backend = id
  }

  if (isPlainObject(cfg.defaults)) {
    const d = cfg.defaults
    if (typeof d.maxChars === "number" && Number.isFinite(d.maxChars)) {
      out.defaults.maxChars = clamp(Math.floor(d.maxChars), MAX_CHARS_FLOOR, MAX_CHARS_CEILING)
    }
    if (typeof d.waitTimeoutSec === "number" && Number.isFinite(d.waitTimeoutSec)) {
      out.defaults.waitTimeoutSec = clamp(
        Math.floor(d.waitTimeoutSec),
        WAIT_TIMEOUT_FLOOR_SEC,
        WAIT_TIMEOUT_CEILING_SEC,
      )
    }
  }

  // Per-backend blocks: any object-valued key under cfg (other than the
  // known top-level keys) is treated as a backend config block.
  const knownTop = new Set(["enabled", "backend", "defaults"])
  const backends: Record<string, BackendConfig> = {}
  for (const [k, v] of Object.entries(cfg)) {
    if (knownTop.has(k)) continue
    if (!isPlainObject(v)) continue
    const block: BackendConfig = {}
    if (typeof v.bin === "string" && v.bin.trim().length > 0) {
      block.bin = v.bin.trim()
    }
    if (typeof v.voice === "string" && v.voice.trim().length > 0) {
      block.voice = v.voice.trim()
    }
    if (typeof v.rate === "number" && Number.isFinite(v.rate) && v.rate > 0) {
      block.rate = Math.floor(v.rate)
    }
    backends[k] = block
  }
  out.backends = backends

  return out
}

/**
 * Load + parse user config. Always returns a valid `SpeakConfig` - built-in
 * defaults on any failure. Use `defaultConfig()` directly to skip disk IO
 * (tests, CLI use cases).
 */
export function loadSpeakConfig(): SpeakConfig {
  const path = configPath()
  const raw = readRaw(path)
  if (raw === null) return defaultConfig()
  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
  } catch (err) {
    if (process.env.DEBUG === "1") {
      process.stderr.write(`[ma-speak] ${path}: parse error: ${(err as Error).message}\n`)
    }
    return defaultConfig()
  }
  return parseSpeakConfig(parsed)
}
