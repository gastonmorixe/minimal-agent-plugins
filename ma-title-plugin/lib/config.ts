/**
 * Title plugin config (SPEC §7.2-7.3).
 *
 * Source: `<agent home>/config.jsonc` (or `config.json`, or the path in
 * `MINIMAL_AGENT_CONFIG`), key path `plugins.title`. The agent home is
 * `MINIMAL_AGENT_HOME` when set (core `resolveAgentHome`).
 *
 * Lenient: a missing file, a missing block, bad JSONC, an unknown key or a
 * wrong type gives the default and one debug line. The loader never throws,
 * so the plugin never fails at load because of its config.
 *
 * Env: `MINIMAL_AGENT_TITLE=0|1` (0 = kill switch, 1 = allow in the current
 * mode) and `MINIMAL_AGENT_TITLE_MODEL=<id>`. Args (P4): `--title` and
 * `--no-title`. Precedence: args \> env \> config \> default.
 *
 * @module lib/config
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { resolveAgentHome } from "@minimal-agent/core/plugin-api/utils/agent-paths"
import { parseJsonc } from "@minimal-agent/core/plugin-api/utils/jsonc"

import type { RunMode, TitleEffort } from "./host-types.ts"

/** The key of the plugin block under `plugins`. */
export const TITLE_CONFIG_KEY = "title"
/** Env: `0` = kill switch, `1` = allow in the current mode. */
export const TITLE_ENV = "MINIMAL_AGENT_TITLE"
/** Env: model override. */
export const TITLE_MODEL_ENV = "MINIMAL_AGENT_TITLE_MODEL"
/** Env: path of the config file (same as core). */
export const CONFIG_PATH_ENV = "MINIMAL_AGENT_CONFIG"

/** All run modes (`RunMode` in plugin-api). */
export const RUN_MODES: readonly RunMode[] = ["repl", "one-shot", "stream-json", "host", "subagent"]

/** Accepted `effort` values (the host `LlmSideRequest.effort`). */
export const TITLE_EFFORTS: readonly TitleEffort[] = ["low", "medium", "high"]

/** Sub-agent policy (SPEC §7.4). */
export type SubagentPolicy = "off" | "derived" | "model"
const SUBAGENT_POLICIES: readonly SubagentPolicy[] = ["off", "derived", "model"]

/** Default `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 10_000
/** Lower clamp for `timeoutMs`. */
export const TIMEOUT_MS_MIN = 1000
/** Upper clamp for `timeoutMs`. */
export const TIMEOUT_MS_MAX = 30_000
/** Default `minChars` (SPEC §6 rule 6). */
export const DEFAULT_MIN_CHARS = 10
/** Default `maxUsdPerMTokIn` (SPEC §4.2 cost guard). */
export const DEFAULT_MAX_USD_PER_MTOK_IN = 1.0

/**
 * Run modes that are ON when the user set nothing (SPEC §7.1). P1a: empty,
 * so the plugin is OFF by default. P1b changes this to `["repl"]`
 * (interactive only).
 */
export const DEFAULT_ON_MODES: readonly RunMode[] = []

/** The parsed `plugins.title` block, with defaults. */
export interface TitleConfig {
  /** Plugin enable (core also reads it). Default `true`. */
  enabled: boolean
  /** Model override (SPEC §4.3 item 5): a model of the session provider. Default unset. */
  model?: string
  /**
   * Run modes that the user allows. `undefined` = the user did not set the
   * key; then {@link DEFAULT_ON_MODES} applies.
   */
  modes?: RunMode[]
  /** Sub-agent policy. Default `"off"`. */
  subagents: SubagentPolicy
  /**
   * Effort of the title call. Default unset: the provider title profile
   * gives the effort (SPEC §4.3 item 5).
   */
  effort?: TitleEffort
  /** Price ceiling, $ per M input tokens. Default `1.0`. */
  maxUsdPerMTokIn: number
  /** Side-call timeout, clamped to 1000-30000. Default `10000`. */
  timeoutMs: number
  /** Min clean prompt length (code points). Default `10`. */
  minChars: number
}

/** A debug log sink. */
export type DebugLog = (msg: string) => void

/** Built-in defaults. Pure. */
export function defaultTitleConfig(): TitleConfig {
  return {
    enabled: true,
    subagents: "off",
    maxUsdPerMTokIn: DEFAULT_MAX_USD_PER_MTOK_IN,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    minChars: DEFAULT_MIN_CHARS,
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

function isRunMode(v: unknown): v is RunMode {
  return typeof v === "string" && (RUN_MODES as readonly string[]).includes(v)
}

const KNOWN_KEYS = new Set([
  "enabled",
  "model",
  "modes",
  "subagents",
  "effort",
  "maxUsdPerMTokIn",
  "timeoutMs",
  "minChars",
])

/**
 * Parse a full config object (the whole `config.jsonc` value) and return the
 * `plugins.title` block with defaults. Pure, never throws. Each unknown key
 * and each wrong value gives one `debug` line.
 */
export function parseTitleConfig(raw: unknown, debug: DebugLog = () => {}): TitleConfig {
  const out = defaultTitleConfig()
  if (!isPlainObject(raw) || !isPlainObject(raw.plugins)) return out
  const cfg = raw.plugins[TITLE_CONFIG_KEY]
  if (cfg === undefined) return out
  if (!isPlainObject(cfg)) {
    debug(`plugins.${TITLE_CONFIG_KEY}: not an object; defaults used`)
    return out
  }
  const bad = (key: string): void =>
    debug(`plugins.${TITLE_CONFIG_KEY}.${key}: wrong value; default used`)

  for (const key of Object.keys(cfg)) {
    if (!KNOWN_KEYS.has(key)) debug(`plugins.${TITLE_CONFIG_KEY}.${key}: unknown key; ignored`)
  }

  if (cfg.enabled !== undefined) {
    if (typeof cfg.enabled === "boolean") out.enabled = cfg.enabled
    else bad("enabled")
  }

  if (cfg.effort !== undefined) {
    const v = cfg.effort
    if (typeof v === "string" && (TITLE_EFFORTS as readonly string[]).includes(v)) {
      out.effort = v as TitleEffort
    } else {
      bad("effort")
    }
  }

  if (cfg.model !== undefined) {
    if (typeof cfg.model === "string" && cfg.model.trim() !== "") out.model = cfg.model.trim()
    else bad("model")
  }

  if (cfg.modes !== undefined) {
    if (Array.isArray(cfg.modes)) {
      const modes: RunMode[] = []
      for (const m of cfg.modes) {
        if (isRunMode(m)) {
          if (!modes.includes(m)) modes.push(m)
        } else {
          debug(`plugins.${TITLE_CONFIG_KEY}.modes: unknown mode ${JSON.stringify(m)}; ignored`)
        }
      }
      out.modes = modes
    } else {
      bad("modes")
    }
  }

  if (cfg.subagents !== undefined) {
    const v = cfg.subagents
    if (typeof v === "string" && (SUBAGENT_POLICIES as readonly string[]).includes(v)) {
      out.subagents = v as SubagentPolicy
    } else {
      bad("subagents")
    }
  }

  if (cfg.maxUsdPerMTokIn !== undefined) {
    if (isFiniteNumber(cfg.maxUsdPerMTokIn) && cfg.maxUsdPerMTokIn >= 0) {
      out.maxUsdPerMTokIn = cfg.maxUsdPerMTokIn
    } else {
      bad("maxUsdPerMTokIn")
    }
  }

  if (cfg.timeoutMs !== undefined) {
    if (isFiniteNumber(cfg.timeoutMs)) {
      out.timeoutMs = Math.min(TIMEOUT_MS_MAX, Math.max(TIMEOUT_MS_MIN, Math.round(cfg.timeoutMs)))
    } else {
      bad("timeoutMs")
    }
  }

  if (cfg.minChars !== undefined) {
    if (isFiniteNumber(cfg.minChars) && cfg.minChars >= 1) out.minChars = Math.floor(cfg.minChars)
    else bad("minChars")
  }

  return out
}

/**
 * Path of the config file. `MINIMAL_AGENT_CONFIG` wins; else
 * `<agent home>/config.jsonc` when it exists; else `<agent home>/config.json`.
 */
export function titleConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[CONFIG_PATH_ENV]?.trim()
  if (explicit) return explicit
  const home = resolveAgentHome(env)
  const jsonc = join(home, "config.jsonc")
  return existsSync(jsonc) ? jsonc : join(home, "config.json")
}

/**
 * Read and parse the config file. Always gives a valid config: defaults on a
 * missing file, a read error or a parse error (with one debug line). Read
 * only; never writes. The parsed value is kept for each path: when the file
 * mtime and size do not change, the loader does only a `stat` (no read and no
 * parse), and the debug lines of the parse do not come again.
 */
export function loadTitleConfig(
  env: NodeJS.ProcessEnv = process.env,
  debug: DebugLog = () => {},
): TitleConfig {
  const path = titleConfigPath(env)
  let text: string
  let stamp: string
  try {
    if (!existsSync(path)) return defaultTitleConfig()
    const st = statSync(path)
    stamp = `${st.mtimeMs}:${st.size}`
    const hit = configCache.get(path)
    if (hit && hit.stamp === stamp) return { ...hit.config, ...copyModes(hit.config) }
    text = readFileSync(path, "utf-8")
  } catch (err) {
    debug(`config ${path}: read error: ${(err as Error).message}`)
    return defaultTitleConfig()
  }
  const config = parseConfigText(path, text, debug)
  configCache.set(path, { stamp, config })
  return { ...config, ...copyModes(config) }
}

/** Parsed config for each path, with the file `mtimeMs:size` stamp. */
const configCache = new Map<string, { stamp: string; config: TitleConfig }>()

/** Clear the config cache (tests). */
export function clearTitleConfigCache(): void {
  configCache.clear()
}

/** A copy of `modes`, so that a caller cannot change the cached array. */
function copyModes(c: TitleConfig): Partial<TitleConfig> {
  return c.modes ? { modes: [...c.modes] } : {}
}

function parseConfigText(path: string, text: string, debug: DebugLog): TitleConfig {
  let parsed: unknown
  try {
    parsed = parseJsonc(text)
  } catch (err) {
    debug(`config ${path}: parse error: ${(err as Error).message}`)
    return defaultTitleConfig()
  }
  return parseTitleConfig(parsed, debug)
}

/** The title switches from the env. */
export interface TitleEnv {
  /** `MINIMAL_AGENT_TITLE`: `false` = `0`, `true` = `1`, unset or other = undefined. */
  title?: boolean
  /** `MINIMAL_AGENT_TITLE_MODEL`, trimmed; unset when empty. */
  model?: string
}

/** The title switches from the CLI args (P4: `--title` / `--no-title`). */
export interface TitleArgs {
  /** `true` = `--title`, `false` = `--no-title`. */
  title?: boolean
}

/** Read the title switches from the env. Other values than `0`/`1` are ignored. */
export function readTitleEnv(env: NodeJS.ProcessEnv = process.env): TitleEnv {
  const out: TitleEnv = {}
  const flag = env[TITLE_ENV]?.trim()
  if (flag === "0") out.title = false
  else if (flag === "1") out.title = true
  const model = env[TITLE_MODEL_ENV]?.trim()
  if (model) out.model = model
  return out
}

/**
 * The title switch after precedence: args \> env. `undefined` = no switch;
 * then the config and the defaults decide.
 */
export function resolveTitleSwitch(
  args: TitleArgs | undefined,
  env: TitleEnv,
): boolean | undefined {
  if (args?.title !== undefined) return args.title
  return env.title
}

/**
 * The model override after precedence (SPEC §7.3):
 * `MINIMAL_AGENT_TITLE_MODEL` \> `plugins.title.model`. `undefined` = use the
 * provider choice (SPEC §4.2 steps 2-5).
 */
export function resolveModelOverride(config: TitleConfig, env: TitleEnv): string | undefined {
  return env.model ?? config.model
}
