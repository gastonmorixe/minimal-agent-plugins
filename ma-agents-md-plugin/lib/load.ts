/**
 * Pure AGENTS.md discovery + rendering for the agents-md plugin.
 *
 * Loads zero, one, or both of:
 *   1. Global: `<agent-home>/AGENTS.md`  (user-wide, via MINIMAL_AGENT_HOME)
 *   2. Project: `<cwd>/AGENTS.md`        (agents.md convention for the folder)
 *
 * Order is intentional: **global first, project second**. That matches the
 * mental model "user defaults, then project overrides / adds detail", and
 * keeps the more-specific project guidance closer to the model's recent
 * context window when both exist.
 *
 * The agent home is NEVER hardcoded as `~/.minimal-agent`. The host
 * publishes the resolved path as `MINIMAL_AGENT_HOME` at boot; we read
 * that (via {@link agentHome}) so relocated installs, sandboxes, and tests
 * stay correct.
 *
 * Empty / missing / oversized files contribute nothing. The fragment
 * producer returns `""` when nothing loaded, and the host loader treats
 * empty fragments as "skip" so the system prompt stays clean.
 *
 * @module lib/load
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { agentHome } from "./agent-home.ts"
import type { AgentsMdConfig } from "./config.ts"
import { DEFAULT_AGENTS_MD_CONFIG } from "./config.ts"

/** One successfully loaded AGENTS.md source. */
export interface AgentsMdSource {
  /** Stable scope tag (load order / diagnostics only; not rendered). */
  scope: "global" | "project"
  /** Absolute path the body was read from. */
  path: string
  /** Trimmed file body (UTF-8). */
  body: string
}

/** Inputs for {@link collectAgentsMdSources} / {@link renderAgentsMdFragment}. */
export interface LoadAgentsMdOptions {
  /** Project working directory (`<cwd>/AGENTS.md`). */
  cwd: string
  /** Env bag; must carry `MINIMAL_AGENT_HOME` in production. */
  env?: NodeJS.ProcessEnv
  /** Fully-defaulted config. Defaults to {@link DEFAULT_AGENTS_MD_CONFIG}. */
  config?: AgentsMdConfig
  /**
   * Optional diagnostic sink. Called when a candidate exists but is
   * skipped (unreadable, oversized, empty). Tests may capture these.
   */
  onSkip?: (reason: string) => void
}

/**
 * Resolve the absolute path of the user-global AGENTS.md.
 *
 * Honors `MINIMAL_AGENT_HOME` (published by the host). Never hardcodes
 * `~/.minimal-agent`.
 */
export function globalAgentsMdPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentHome(env), "AGENTS.md")
}

/**
 * Resolve the absolute path of the project AGENTS.md for a given cwd.
 * Convention: exactly `AGENTS.md` at the project root (case-sensitive on
 * case-sensitive filesystems; matches http://agents.md).
 */
export function projectAgentsMdPath(cwd: string): string {
  return join(cwd, "AGENTS.md")
}

/**
 * Read a candidate AGENTS.md if present, under the size cap.
 * Returns null when missing, empty, unreadable, or oversized.
 */
export function readAgentsMdFile(
  path: string,
  maxBytes: number,
  onSkip?: (reason: string) => void,
): string | null {
  if (!existsSync(path)) return null
  try {
    const st = statSync(path)
    if (!st.isFile()) {
      onSkip?.(`skip ${path}: not a regular file`)
      return null
    }
    if (st.size > maxBytes) {
      onSkip?.(
        `skip ${path}: ${st.size} bytes exceeds maxBytes=${maxBytes}; raise plugins["agents-md"].maxBytes or shrink the file`,
      )
      return null
    }
    const body = readFileSync(path, "utf-8")
      .replace(/^\uFEFF/, "")
      .trim()
    if (!body) {
      onSkip?.(`skip ${path}: empty`)
      return null
    }
    return body
  } catch (err) {
    onSkip?.(`skip ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Collect loadable AGENTS.md sources in render order: global, then project.
 * Pure-ish (disk reads only). Does not render.
 */
export function collectAgentsMdSources(opts: LoadAgentsMdOptions): AgentsMdSource[] {
  const cfg = opts.config ?? DEFAULT_AGENTS_MD_CONFIG
  const env = opts.env ?? process.env
  const sources: AgentsMdSource[] = []

  if (cfg.global) {
    const path = globalAgentsMdPath(env)
    const body = readAgentsMdFile(path, cfg.maxBytes, opts.onSkip)
    if (body) sources.push({ scope: "global", path, body })
  }

  if (cfg.project) {
    const path = projectAgentsMdPath(opts.cwd)
    const body = readAgentsMdFile(path, cfg.maxBytes, opts.onSkip)
    if (body) sources.push({ scope: "project", path, body })
  }

  return sources
}

/**
 * Render the system-prompt fragment from loaded sources.
 *
 * Returns `""` when nothing loaded. Otherwise the raw file bodies joined
 * with a blank line between them (global then project). No framing
 * headers, intro prose, or path headings: the user forbids any
 * prepend/append around AGENTS.md injection.
 *
 * Pure: no IO. Exported so tests can drive rendering without the fs.
 */
export function renderAgentsMdFragment(sources: readonly AgentsMdSource[]): string {
  if (sources.length === 0) return ""
  return sources.map((s) => s.body).join("\n\n")
}

/**
 * End-to-end: collect + render. Convenience for the prompt-fragment handler.
 */
export function loadAgentsMdFragment(opts: LoadAgentsMdOptions): string {
  return renderAgentsMdFragment(collectAgentsMdSources(opts))
}
