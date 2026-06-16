/**
 * Plugin config loader.
 *
 * Source: `~/.minimal-agent/config.jsonc` (or `MINIMAL_AGENT_CONFIG`),
 * key path: `plugins["ma-bg"]`.
 *
 * Lenient: a missing file, missing section, malformed JSON, or wrong types all
 * fall back to built-in defaults. Never throws: a misconfigured plugin must not
 * crash the agent at startup. Runtime errors are the handler's job.
 *
 * Shape:
 *
 * ```jsonc
 *   {
 *     "plugins": {
 *       "ma-bg": {
 *         "enabled": true,                  // default true
 *         "defaults": {
 *           "timeout": "10m",               // default per-job deadline
 *           "maxTimeout": "1d",             // hard ceiling (NOT model-facing)
 *           "allowInfinite": false          // gate the "infinite" escape hatch
 *         },
 *         "limits": {
 *           "maxConcurrent": 16,            // running jobs at once
 *           "maxTotal": 128                 // retained index records (FIFO evict)
 *         },
 *         "log": {
 *           "maxModelBytes": 65536          // cap on a single model-facing read
 *         }
 *       }
 *     }
 *   }
 * ```
 *
 * Everything here is operator config. The model controls only WHAT runs and an
 * optional per-job `timeout` string, it never sees the ceiling or the limits.
 *
 * @module lib/config
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { formatDuration, INFINITE_MS, ONE_DAY_MS, parseDuration } from "./duration.ts"
import { parseJsonc } from "./jsonc.ts"

/** Plugin-wide defaults applied to each job unless the model overrides. */
export interface BgDefaults {
  /** Default per-job deadline in ms (the parsed `timeout`). */
  timeoutMs: number
  /** Hard ceiling in ms a finite job timeout is clamped to. */
  maxTimeoutMs: number
  /** Whether the model may request an infinite timeout. */
  allowInfinite: boolean
}

/** Concurrency / retention limits. */
export interface BgLimits {
  /** Max jobs in the `running` state at once. */
  maxConcurrent: number
  /** Max retained index records; oldest terminal records evicted past this. */
  maxTotal: number
}

/** Log-reading limits. */
export interface BgLogConfig {
  /** Cap on bytes returned to the model from a single read. The on-disk log is
   *  never capped, this only bounds what crosses into context. */
  maxModelBytes: number
}

export interface BgConfig {
  /** When `false`, the plugin refuses to start jobs (handler returns an error). */
  enabled: boolean
  defaults: BgDefaults
  limits: BgLimits
  log: BgLogConfig
}

// Built-in default magnitudes.
export const DEFAULT_TIMEOUT_MS = 600_000 // 10m
export const DEFAULT_MAX_TIMEOUT_MS = ONE_DAY_MS // 1d
export const DEFAULT_MAX_CONCURRENT = 16
export const DEFAULT_MAX_TOTAL = 128
export const DEFAULT_MAX_MODEL_BYTES = 65_536

// Floors / ceilings so a wild config value can't make a knob useless.
export const MAX_CONCURRENT_CEILING = 256
export const MAX_TOTAL_CEILING = 4096
export const MAX_MODEL_BYTES_FLOOR = 1024
export const MAX_MODEL_BYTES_CEILING = 1_048_576

/** Built-in defaults. Pure: no IO. */
export function defaultConfig(): BgConfig {
  return {
    enabled: true,
    defaults: {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxTimeoutMs: DEFAULT_MAX_TIMEOUT_MS,
      allowInfinite: false,
    },
    limits: {
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      maxTotal: DEFAULT_MAX_TOTAL,
    },
    log: {
      maxModelBytes: DEFAULT_MAX_MODEL_BYTES,
    },
  }
}

/** Resolve config file path. Mirrors `src/config.ts:configPath` in minimal-agent. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MINIMAL_AGENT_CONFIG) return env.MINIMAL_AGENT_CONFIG
  const dir = join(homedir(), ".minimal-agent")
  const jsoncPath = join(dir, "config.jsonc")
  if (existsSync(jsoncPath)) return jsoncPath
  return join(dir, "config.json")
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Resolve a config timeout value (string like "1d" or a number of seconds) to
 * ms, with a fixed ceiling of one day. `allowInfinite` controls whether the
 * "infinite" tokens resolve to {@link INFINITE_MS}, when false, an infinite
 * request fails to parse and falls back to `fallbackMs`. Falls back to
 * `fallbackMs` on any parse failure or non-string/number input.
 */
function resolveConfigDuration(raw: unknown, fallbackMs: number, allowInfinite: boolean): number {
  if (typeof raw !== "string" && typeof raw !== "number") return fallbackMs
  const r = parseDuration(raw, {
    defaultMs: fallbackMs,
    maxMs: ONE_DAY_MS,
    allowInfinite,
    minMs: 1000,
  })
  return r.ok ? r.value.ms : fallbackMs
}

/**
 * Validate and normalize a `plugins["ma-bg"]` block. Unknown / wrong-type
 * fields are dropped silently, valid fields override defaults. Pure: takes
 * parsed JSON, returns the merged config. Exposed for tests.
 */
export function parseBgConfig(raw: unknown): BgConfig {
  const out = defaultConfig()
  if (!isPlainObject(raw)) return out
  const plugins = raw.plugins
  if (!isPlainObject(plugins)) return out
  const cfg = plugins["ma-bg"]
  if (!isPlainObject(cfg)) return out

  if (typeof cfg.enabled === "boolean") out.enabled = cfg.enabled

  if (isPlainObject(cfg.defaults)) {
    const d = cfg.defaults
    if (typeof d.allowInfinite === "boolean") out.defaults.allowInfinite = d.allowInfinite
    // The ceiling is always finite (an infinite ceiling can't clamp anything).
    out.defaults.maxTimeoutMs = resolveConfigDuration(
      d.maxTimeout,
      out.defaults.maxTimeoutMs,
      false,
    )
    // The default timeout respects the infinite gate, an infinite request with
    // the gate off falls back to the built-in default ms.
    const t = resolveConfigDuration(d.timeout, out.defaults.timeoutMs, out.defaults.allowInfinite)
    out.defaults.timeoutMs =
      t === INFINITE_MS ? INFINITE_MS : Math.min(t, out.defaults.maxTimeoutMs)
  }

  if (isPlainObject(cfg.limits)) {
    const l = cfg.limits
    if (typeof l.maxConcurrent === "number" && Number.isFinite(l.maxConcurrent)) {
      out.limits.maxConcurrent = clamp(Math.floor(l.maxConcurrent), 1, MAX_CONCURRENT_CEILING)
    }
    if (typeof l.maxTotal === "number" && Number.isFinite(l.maxTotal)) {
      out.limits.maxTotal = clamp(Math.floor(l.maxTotal), 1, MAX_TOTAL_CEILING)
    }
  }

  if (isPlainObject(cfg.log)) {
    const lg = cfg.log
    if (typeof lg.maxModelBytes === "number" && Number.isFinite(lg.maxModelBytes)) {
      out.log.maxModelBytes = clamp(
        Math.floor(lg.maxModelBytes),
        MAX_MODEL_BYTES_FLOOR,
        MAX_MODEL_BYTES_CEILING,
      )
    }
  }

  return out
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

/**
 * Load + parse user config. Always returns a valid {@link BgConfig}: built-in
 * defaults on any failure. Use {@link defaultConfig} directly to skip disk IO
 * (tests).
 */
export function loadBgConfig(env: NodeJS.ProcessEnv = process.env): BgConfig {
  const path = configPath(env)
  const raw = readRaw(path)
  if (raw === null) return defaultConfig()
  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
  } catch (e) {
    if (env.DEBUG === "1") {
      process.stderr.write(`[ma-bg] ${path}: parse error: ${(e as Error).message}\n`)
    }
    return defaultConfig()
  }
  return parseBgConfig(parsed)
}

/** Human-readable summary of the resolved config (for diagnostics). Pure. */
export function describeConfig(cfg: BgConfig): string {
  return (
    `enabled=${cfg.enabled} ` +
    `default=${formatDuration(cfg.defaults.timeoutMs)} ` +
    `max=${formatDuration(cfg.defaults.maxTimeoutMs)} ` +
    `infinite=${cfg.defaults.allowInfinite} ` +
    `concurrent=${cfg.limits.maxConcurrent} total=${cfg.limits.maxTotal}`
  )
}
