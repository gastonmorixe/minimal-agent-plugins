/**
 * Tool-call handler for the `Skill` tool.
 *
 * Three actions:
 *
 *   list        → enumerate discovered skills + broken + shadowed.
 *                 `content`  = JSON, model-friendly.
 *                 `display`  = ANSI table for the transcript.
 *
 *   info <name> → show frontmatter for one skill (no body load).
 *                 `content`  = canonical YAML frontmatter dump.
 *                 `display`  = ANSI key/value block.
 *
 *   read <name> → load full SKILL.md body into context, plus a footer
 *                 listing bundled siblings (`scripts/`, `references/`,
 *                 etc.) so the model knows what to `Read` next.
 *                 `content`  = body text + sibling listing.
 *                 `display`  = clipped preview for the transcript.
 *                 `_truncCtx`= wired so the universal output guardrail
 *                              can clamp huge SKILL.md files cleanly.
 *
 * @module handlers/skill
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"

import { formatAllowedTools, parseAllowedTools } from "../lib/allowed-tools.ts"
import { loadSkillsConfig } from "../lib/config.ts"
import { discoverSkills, findSkill, listSiblings } from "../lib/discovery.ts"
import type {
  BrokenSkill,
  DiscoveryResult,
  Skill,
  SkillScope,
  TUIContext,
  TUIHandler,
  TUIResult,
} from "../lib/types.ts"

import { shortenPath } from "./prompt-fragment.ts"

// ---------------------------------------------------------------------------
// Constants / styling
// ---------------------------------------------------------------------------

const FALLBACK_SGR = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  weightReset: "\x1b[22m",
  red: "\x1b[31m",
  fgReset: "\x1b[39m",
} as const

export interface SgrTokens {
  readonly dim: string
  readonly bold: string
  readonly weightReset: string
  readonly red: string
  readonly fgReset: string
}

/** Resolve style tokens from the host-injected palette environment. */
export function resolveSgr(raw = process.env.MINIMAL_AGENT_PALETTE): SgrTokens {
  const palette = parsePaletteEnv(raw)
  return {
    ...FALLBACK_SGR,
    red: palette?.red ?? FALLBACK_SGR.red,
    fgReset: palette?._fgReset ?? FALLBACK_SGR.fgReset,
  }
}

function parsePaletteEnv(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value
    }
    return out
  } catch {
    return null
  }
}

const SGR = resolveSgr()
const DIM = SGR.dim
const RESET = SGR.weightReset
const BOLD = SGR.bold
const RESET_BOLD = SGR.weightReset
const RED = SGR.red
const RESET_FG = SGR.fgReset

const SCOPE_LABEL: Record<SkillScope, string> = {
  project: "project",
  projectClaudeCode: "project (.claude)",
  homeShared: "home",
  userAgent: "user",
  extra: "extra",
}

const VALID_ACTIONS = new Set(["list", "info", "read"])

const PREVIEW_LINES = 14
const PREVIEW_LINE_WIDTH = 240

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export type Action = "list" | "info" | "read"

export interface ParsedInput {
  action: Action
  name?: string
}

export type ValidateResult = { ok: true; value: ParsedInput } | { ok: false; error: string }

/** Validate the raw tool input into a typed `{action, name?}` or a user-facing error. */
export function validateInput(raw: Record<string, unknown>): ValidateResult {
  if (typeof raw.action !== "string" || raw.action.length === 0) {
    return { ok: false, error: "`action` is required (one of: list, info, read)" }
  }
  if (!VALID_ACTIONS.has(raw.action)) {
    return {
      ok: false,
      error: `unknown action "${raw.action}" (expected one of: list, info, read)`,
    }
  }
  const action = raw.action as Action

  if (action === "list") {
    return { ok: true, value: { action } }
  }

  if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
    return {
      ok: false,
      error: `\`name\` is required for action="${action}"`,
    }
  }
  return { ok: true, value: { action, name: raw.name.trim() } }
}

// ---------------------------------------------------------------------------
// Default export — handler dispatcher
// ---------------------------------------------------------------------------

const handler: TUIHandler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") {
    return errResult("Skill: wrong trigger type")
  }
  const v = validateInput(ctx.trigger.input)
  if (!v.ok) return errResult(`Skill: ${v.error}`)

  const config = loadSkillsConfig()
  if (!config.enabled) {
    return errResult(
      'Skill: plugin is disabled in user config (plugins["ma-skills"].enabled = false)',
    )
  }

  const cwd = ctx.cwd
  const home = homedir()
  const result = discoverSkills(config, cwd, home)

  switch (v.value.action) {
    case "list":
      return doList(result, cwd, home)
    case "info":
      return doInfo(result, v.value.name as string, cwd, home)
    case "read":
      return doRead(result, v.value.name as string, cwd, home)
  }
}

export default handler

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

interface ListJsonEntry {
  name: string
  description: string
  scope: SkillScope
  dir: string
  license?: string
  compatibility?: string
  hasAllowedTools: boolean
}

/** Build the JSON payload sent to the model for `list`. */
export function buildListJson(result: DiscoveryResult): {
  skills: ListJsonEntry[]
  broken: Array<{ dirName: string; dir: string; scope: SkillScope; errors: string[] }>
  shadowed: Array<{ name: string; dir: string; scope: SkillScope; shadowedBy: SkillScope }>
} {
  return {
    skills: result.skills.map((s) => ({
      name: s.front.name,
      description: s.front.description,
      scope: s.scope,
      dir: s.dir,
      license: s.front.license,
      compatibility: s.front.compatibility,
      hasAllowedTools: !!s.front.allowedTools && s.front.allowedTools.length > 0,
    })),
    broken: result.broken.map((b) => ({
      dirName: b.dirName,
      dir: b.dir,
      scope: b.scope,
      errors: b.errors,
    })),
    shadowed: result.shadowed.map((s) => ({
      name: s.skill.front.name,
      dir: s.skill.dir,
      scope: s.skill.scope,
      shadowedBy: s.shadowedBy,
    })),
  }
}

/** Build the ANSI display table for the transcript. */
export function buildListDisplay(result: DiscoveryResult, cwd: string, home: string): string {
  if (result.skills.length === 0 && result.broken.length === 0) {
    return `${DIM}(no skills discovered)${RESET}`
  }
  const lines: string[] = []
  if (result.skills.length > 0) {
    lines.push(`${BOLD}skills${RESET_BOLD} (${result.skills.length})`)
    for (const s of result.skills) {
      const desc = clip(s.front.description, 80)
      lines.push(
        `  ${BOLD}${s.front.name}${RESET_BOLD}  ${DIM}${SCOPE_LABEL[s.scope]}  ${shortenPath(s.dir, cwd, home)}${RESET}`,
      )
      lines.push(`    ${desc}`)
    }
  }
  if (result.broken.length > 0) {
    lines.push("")
    lines.push(`${BOLD}${RED}broken${RESET_FG}${RESET_BOLD} (${result.broken.length})`)
    for (const b of result.broken) {
      lines.push(
        `  ${RED}${b.dirName}${RESET_FG}  ${DIM}${SCOPE_LABEL[b.scope]}  ${shortenPath(b.dir, cwd, home)}${RESET}`,
      )
      lines.push(
        `    ${DIM}${b.errors[0] ?? "unknown"}${b.errors.length > 1 ? `  (+${b.errors.length - 1} more)` : ""}${RESET}`,
      )
    }
  }
  return lines.join("\n")
}

function doList(result: DiscoveryResult, cwd: string, home: string): TUIResult {
  const json = buildListJson(result)
  const content = JSON.stringify(json, null, 2)
  return {
    kind: "tool_result",
    content,
    display: buildListDisplay(result, cwd, home),
    displayHeader: `list  ${DIM}${result.skills.length} ok · ${result.broken.length} broken · ${result.shadowed.length} shadowed${RESET}`,
  }
}

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------

/** Render a skill's frontmatter as canonical YAML (model-facing). */
export function buildInfoContent(s: Skill): string {
  const lines: string[] = []
  lines.push(`name: ${s.front.name}`)
  lines.push(`description: ${quoteIfNeeded(s.front.description)}`)
  if (s.front.license) lines.push(`license: ${quoteIfNeeded(s.front.license)}`)
  if (s.front.compatibility) lines.push(`compatibility: ${quoteIfNeeded(s.front.compatibility)}`)
  if (s.front.metadata) {
    lines.push("metadata:")
    for (const [k, v] of Object.entries(s.front.metadata)) {
      lines.push(`  ${k}: ${quoteIfNeeded(v)}`)
    }
  }
  if (s.front.allowedTools && s.front.allowedTools.length > 0) {
    const entries = s.front.allowedTools.map(parseToken1)
    lines.push(`allowed-tools: ${formatAllowedTools(entries)}`)
  }
  lines.push("")
  lines.push(`# scope: ${SCOPE_LABEL[s.scope]}`)
  lines.push(`# path:  ${s.dir}`)
  return lines.join("\n")
}

/** Quote a string for inline YAML if it has any characters that need it. */
function quoteIfNeeded(s: string): string {
  if (/^[A-Za-z0-9._/\- ]+$/.test(s) && s.trim() === s) return s
  // Use double quotes with minimal escaping.
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
  return `"${escaped}"`
}

/** Lift one token through the allowed-tools parser so info round-trips. */
function parseToken1(tok: string): import("../lib/allowed-tools.ts").AllowedToolEntry {
  return parseAllowedTools(tok)[0] ?? { tool: tok, raw: tok }
}

function buildInfoDisplay(s: Skill, cwd: string, home: string): string {
  const lines: string[] = []
  lines.push(`${BOLD}${s.front.name}${RESET_BOLD}  ${DIM}${SCOPE_LABEL[s.scope]}${RESET}`)
  lines.push(`${DIM}${shortenPath(s.dir, cwd, home)}${RESET}`)
  lines.push("")
  lines.push(`${DIM}description${RESET}  ${s.front.description}`)
  if (s.front.license) lines.push(`${DIM}license    ${RESET}  ${s.front.license}`)
  if (s.front.compatibility) {
    lines.push(`${DIM}compat     ${RESET}  ${s.front.compatibility}`)
  }
  if (s.front.allowedTools && s.front.allowedTools.length > 0) {
    lines.push(`${DIM}allowed    ${RESET}  ${s.front.allowedTools.join(" ")}`)
  }
  if (s.front.metadata && Object.keys(s.front.metadata).length > 0) {
    lines.push(`${DIM}metadata   ${RESET}`)
    for (const [k, v] of Object.entries(s.front.metadata)) {
      lines.push(`  ${DIM}${k}${RESET}  ${v}`)
    }
  }
  return lines.join("\n")
}

function doInfo(result: DiscoveryResult, name: string, cwd: string, home: string): TUIResult {
  const skill = findSkill(result, name)
  if (!skill) {
    return notFound(result, name, "info", cwd, home)
  }
  return {
    kind: "tool_result",
    content: buildInfoContent(skill),
    display: buildInfoDisplay(skill, cwd, home),
    displayHeader: `info  ${DIM}${skill.front.name}${RESET}`,
  }
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

/** Build the model-facing body: SKILL.md body verbatim + sibling trailer. */
export function buildReadContent(skill: Skill, siblings: string[], body: string): string {
  const trimmedBody = body.replace(/\s+$/, "")
  const trailerLines: string[] = []
  trailerLines.push("")
  trailerLines.push("---")
  trailerLines.push(`Skill loaded: ${skill.front.name} (${SCOPE_LABEL[skill.scope]})`)
  trailerLines.push(`Skill dir:    ${skill.dir}`)
  if (siblings.length === 0) {
    trailerLines.push("Bundled:      (none — SKILL.md only)")
  } else {
    trailerLines.push(`Bundled:      ${siblings.join("  ·  ")}`)
    trailerLines.push("")
    trailerLines.push(
      "Use `Read` on any of the bundled paths above when the SKILL.md body references them. Use `Bash` to execute scripts.",
    )
  }
  if (skill.front.allowedTools && skill.front.allowedTools.length > 0) {
    trailerLines.push("")
    trailerLines.push(`Self-enforce \`allowed-tools\`: ${skill.front.allowedTools.join(" ")}`)
  }
  return `${trimmedBody}\n${trailerLines.join("\n")}\n`
}

/** Build the ANSI display body: clipped preview. */
export function buildReadDisplay(body: string): string {
  const lines = body.split("\n")
  const slice = lines.slice(0, PREVIEW_LINES)
  // Drop trailing empties to avoid hollow rows.
  while (slice.length > 0 && slice[slice.length - 1].trim() === "") slice.pop()
  const clipped = slice.map((l) => clip(l, PREVIEW_LINE_WIDTH))
  if (lines.length > PREVIEW_LINES) {
    clipped.push(`${DIM}… (${lines.length - PREVIEW_LINES} more lines)${RESET}`)
  }
  return clipped.join("\n")
}

function doRead(result: DiscoveryResult, name: string, cwd: string, home: string): TUIResult {
  const skill = findSkill(result, name)
  if (!skill) {
    return notFound(result, name, "read", cwd, home)
  }

  if (!existsSync(skill.skillMdPath)) {
    return errResult(`Skill: SKILL.md no longer exists at ${skill.skillMdPath}`)
  }

  let text: string
  try {
    text = readFileSync(skill.skillMdPath, "utf-8")
  } catch (e) {
    return errResult(`Skill: could not read SKILL.md: ${(e as Error).message}`)
  }

  // Body is everything after the frontmatter. We already validated at
  // discovery time, so this never re-fails here — but if the file
  // changed on disk between discovery and read, fall back gracefully.
  const bodyStart = findBodyStart(text)
  const body = bodyStart === -1 ? text : text.slice(bodyStart)
  const siblings = listSiblings(skill)

  const content = buildReadContent(skill, siblings, body)
  const display = buildReadDisplay(body)

  return {
    kind: "tool_result",
    content,
    display,
    displayHeader: `read  ${DIM}${skill.front.name}  ${shortenPath(skill.dir, cwd, home)}${RESET}`,
    displayFooter:
      siblings.length > 0
        ? `${DIM}bundled: ${siblings.length} items · ${SCOPE_LABEL[skill.scope]}${RESET}`
        : `${DIM}${SCOPE_LABEL[skill.scope]}${RESET}`,
    _truncCtx: {
      totalBytes: Buffer.byteLength(content, "utf-8"),
      totalLines: content.split("\n").length,
      tool: "Skill",
    },
  }
}

/** Find the index of the first byte after the closing `---` of frontmatter. */
function findBodyStart(text: string): number {
  // Skip optional BOM.
  let i = 0
  if (text.charCodeAt(0) === 0xfeff) i = 1
  // First line must be `---`. Locate the LF.
  let lf = text.indexOf("\n", i)
  if (lf === -1) return -1
  if (text.slice(i, lf).trimEnd() !== "---") return -1
  // Walk lines looking for the closing `---`.
  let scan = lf + 1
  while (scan < text.length) {
    const next = text.indexOf("\n", scan)
    const line = next === -1 ? text.slice(scan) : text.slice(scan, next)
    if (line.trimEnd() === "---") {
      return next === -1 ? text.length : next + 1
    }
    if (next === -1) return -1
    scan = next + 1
  }
  return -1
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errResult(msg: string): TUIResult {
  return {
    kind: "tool_result",
    content: msg,
    is_error: true,
    displayHeader: `${RED}error${RESET_FG}`,
    display: `${DIM}${msg}${RESET}`,
  }
}

/** Build a helpful "not found" reply listing candidate names. */
function notFound(
  result: DiscoveryResult,
  name: string,
  action: string,
  cwd: string,
  home: string,
): TUIResult {
  const candidates = result.skills.map((s) => s.front.name)
  const brokenNames = result.broken.map((b) => b.dirName)
  const hint =
    candidates.length === 0
      ? "no skills are currently discovered. The catalog is empty."
      : `available: ${candidates.join(", ")}`
  const brokenHint = brokenNames.length > 0 ? ` (broken on disk: ${brokenNames.join(", ")})` : ""
  const msg = `Skill ${action}: no skill named "${name}". ${hint}${brokenHint}`
  // Surface a stub display so the transcript shows what we looked at.
  return {
    kind: "tool_result",
    content: msg,
    is_error: true,
    displayHeader: `${RED}${action}: not found${RESET_FG}`,
    display: `${DIM}requested: ${name}${RESET}\n${DIM}available: ${candidates.length === 0 ? "(none)" : candidates.join(", ")}${RESET}`,
    displayFooter: `${DIM}cwd: ${shortenPath(cwd, cwd, home)}${RESET}`,
  }
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n - 1)}…`
}

// Re-export for tests
export { type BrokenSkill, findBodyStart, listSiblings as _listSiblings }
