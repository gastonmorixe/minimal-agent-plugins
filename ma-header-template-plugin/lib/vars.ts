/**
 * The header variables. Each one is lazy: a template pays only for the
 * names it uses (`branch` runs git, the rest read the payload or env).
 *
 * The session facts come from the `session.willStart` payload and the
 * `MINIMAL_AGENT_*` env the host publishes at boot. No host import.
 *
 * @module header-template/lib/vars
 */

import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { basename } from "node:path"

import type { LazyVars } from "../../ma-template-kit/src/index.ts"

/** The `session.willStart` payload slice this plugin reads. */
export interface SessionFacts {
  sid: string
  cwd: string
  model: string
  source: string
}

/** One documented variable. */
export interface VarDoc {
  name: string
  summary: string
}

/** Every variable, for docs and the README. Keep in sync with {@link buildVars}. */
export const VAR_DOCS: readonly VarDoc[] = [
  { name: "sid", summary: "Session id (full UUID)" },
  { name: "sid.short", summary: "First 8 chars of the session id" },
  { name: "source", summary: "startup, resume, clear, or compact" },
  { name: "model", summary: "Model id" },
  { name: "provider", summary: "Provider id" },
  { name: "effort", summary: "Resolved effort level" },
  { name: "agent", summary: "Agent name (MINIMAL_AGENT_AGENT_NAME)" },
  { name: "version", summary: "minimal-agent version" },
  { name: "pid", summary: "Agent process id" },
  { name: "cwd", summary: "Working directory, absolute" },
  { name: "cwd.tilde", summary: "Working directory, home as ~" },
  { name: "cwd.base", summary: "Last component of the working directory" },
  { name: "branch", summary: "Git branch (runs git, only when used)" },
  { name: "time", summary: "Local time, HH:MM" },
  { name: "date", summary: "Local date, YYYY-MM-DD" },
  { name: "c.dim / c.bold / c.reset / c.<color>", summary: "ANSI styles, empty without a TTY" },
]

/** ANSI styles. Empty strings when color is off. */
const STYLES: Readonly<Record<string, string>> = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  pink: "\x1b[38;5;205m",
  lime: "\x1b[38;5;154m",
  sky: "\x1b[38;5;117m",
}

/** Inputs to {@link buildVars}. Injected for tests. */
export interface VarsInput {
  facts: SessionFacts
  env: Readonly<Record<string, string | undefined>>
  color: boolean
  now?: Date
  home?: string
  gitBranch?: (cwd: string) => string | undefined
}

/** Non-empty string or undefined (so an empty env value counts as absent). */
function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v.trim() !== "" ? v : undefined
}

/** The current git branch of `cwd`, or undefined outside a repo. */
export function gitBranch(cwd: string): string | undefined {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
    timeout: 1000,
  })
  return r.status === 0 ? nonEmpty(r.stdout.trim()) : undefined
}

const pad2 = (n: number): string => String(n).padStart(2, "0")

/** Build the lazy variable map for one render. */
export function buildVars(input: VarsInput): LazyVars {
  const { facts, env } = input
  const now = input.now ?? new Date()
  const home = input.home ?? homedir()
  const branchOf = input.gitBranch ?? gitBranch
  const vars: Record<string, LazyVars[string]> = {
    sid: nonEmpty(facts.sid),
    "sid.short": () => nonEmpty(facts.sid)?.slice(0, 8),
    source: nonEmpty(facts.source),
    model: nonEmpty(facts.model) ?? nonEmpty(env.MINIMAL_AGENT_MODEL),
    provider: nonEmpty(env.MINIMAL_AGENT_PROVIDER),
    effort: nonEmpty(env.MINIMAL_AGENT_EFFORT),
    agent: nonEmpty(env.MINIMAL_AGENT_AGENT_NAME),
    version: nonEmpty(env.MINIMAL_AGENT_VERSION),
    pid: nonEmpty(env.MINIMAL_AGENT_PID),
    cwd: nonEmpty(facts.cwd),
    "cwd.tilde": () =>
      facts.cwd === home || facts.cwd.startsWith(`${home}/`)
        ? `~${facts.cwd.slice(home.length)}`
        : facts.cwd,
    "cwd.base": () => nonEmpty(basename(facts.cwd)),
    branch: () => branchOf(facts.cwd),
    time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    date: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
  }
  for (const [name, code] of Object.entries(STYLES)) {
    vars[`c.${name}`] = input.color ? code : ""
  }
  return vars
}
