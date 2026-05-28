/**
 * Prompt-fragment producer for the ma-skills plugin.
 *
 * Emitted into the system prompt at session start by minimal-agent's
 * plugin loader. Implements **Level 1** of the Agent Skills progressive-
 * disclosure model: just the `name` and `description` of each
 * discovered skill, so the model knows what's available without paying
 * the token cost of every SKILL.md body up front.
 *
 * Output shape (markdown):
 *
 *   ## Skills available this session
 *
 *   <skill-table>
 *
 *   *(Use the `Skill` tool with action="read" name="<name>" to load
 *   the full instructions for one of these, or `Read` the path
 *   directly. Skills marked as broken below are not invocable until
 *   their SKILL.md is fixed.)*
 *
 *   ### Broken skills (parse failures)
 *
 *   - …
 *
 * When discovery finds zero skills, the producer returns the empty
 * string — the loader treats empty fragments as "skip", so the
 * system prompt stays clean.
 *
 * @module handlers/prompt-fragment
 */

import { homedir } from "node:os"
import { relative } from "node:path"

import { loadSkillsConfig } from "../lib/config.ts"
import { discoverSkills } from "../lib/discovery.ts"
import type {
  BrokenSkill,
  DiscoveryResult,
  PromptFragmentContext,
  PromptFragmentHandler,
  Skill,
  SkillScope,
} from "../lib/types.ts"

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/** Display-only label per scope, used in the prompt fragment table. */
const SCOPE_LABEL: Record<SkillScope, string> = {
  project: "project",
  projectClaudeCode: "project (.claude)",
  homeShared: "home",
  userAgent: "user",
  extra: "extra",
}

/**
 * Maximum number of skills enumerated in the fragment. Higher than
 * config.maxSkills shouldn't ever happen because discovery already
 * clamps, but keeping a belt-and-suspenders bound here means the
 * fragment can't accidentally balloon the system prompt.
 */
const MAX_FRAGMENT_ENTRIES = 128

/**
 * Cap on the `description` chunk we render per row. Spec allows up to
 * 1024; we already validate that. The L1 fragment is meant to be a
 * router, not the full doc, so a short clip keeps token cost down.
 * Model can `Skill info` to get the full description verbatim.
 */
const DESC_CLIP = 240

// ---------------------------------------------------------------------------
// Pure renderers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Render the full fragment from a discovery result + cwd/home (for path
 * shortening). Pure — exported so tests can drive it without mocking the
 * config / fs.
 */
export function renderFragment(
  result: DiscoveryResult,
  cwd: string = process.cwd(),
  home: string = homedir(),
): string {
  if (result.skills.length === 0 && result.broken.length === 0) {
    // Nothing to say.
    return ""
  }

  const lines: string[] = []
  lines.push("## Skills available this session")
  lines.push("")

  if (result.skills.length > 0) {
    lines.push(
      'Each skill is a SKILL.md pack that bundles instructions + scripts + references for a specific task. The catalog below is **metadata only** (Level 1 of progressive disclosure). To activate a skill, call `Skill {action: "read", name: "<name>"}` or `Read` the SKILL.md path directly. Then follow the instructions and read referenced files / run scripts on demand.',
    )
    lines.push("")
    lines.push(renderTable(result.skills, cwd, home))
    lines.push("")
  }

  if (result.broken.length > 0) {
    lines.push("### Broken skills (parse / validation failures)")
    lines.push("")
    lines.push(
      "These skills exist on disk but did not validate. Surface them when the user asks about skills so they can fix the SKILL.md.",
    )
    lines.push("")
    for (const b of result.broken.slice(0, 16)) {
      lines.push(renderBrokenRow(b, cwd, home))
    }
    lines.push("")
  }

  if (result.shadowed.length > 0) {
    lines.push("### Shadowed (lower-precedence) skills")
    lines.push("")
    lines.push(
      "These names exist at a higher-precedence root and are not directly invocable. Mention them only if relevant to the user's question.",
    )
    lines.push("")
    for (const s of result.shadowed.slice(0, 16)) {
      lines.push(
        `- \`${s.skill.front.name}\` at ${shortenPath(s.skill.dir, cwd, home)} (shadowed by ${SCOPE_LABEL[s.shadowedBy]})`,
      )
    }
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

/** Render the skills table. */
export function renderTable(skills: Skill[], cwd: string, home: string): string {
  const rows: string[][] = [["name", "scope", "description", "path"]]
  for (const s of skills.slice(0, MAX_FRAGMENT_ENTRIES)) {
    rows.push([
      `\`${s.front.name}\``,
      SCOPE_LABEL[s.scope],
      clip(s.front.description, DESC_CLIP),
      `\`${shortenPath(s.dir, cwd, home)}\``,
    ])
  }
  return renderMarkdownTable(rows)
}

/** Render one broken-skill bullet. */
export function renderBrokenRow(b: BrokenSkill, cwd: string, home: string): string {
  const first = b.errors[0] ?? "unknown error"
  const more = b.errors.length > 1 ? ` (+${b.errors.length - 1} more)` : ""
  return `- \`${b.dirName}\` at ${shortenPath(b.dir, cwd, home)} — ${first}${more}`
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Shorten an absolute path for display: prefer ~/… or ./… forms. */
export function shortenPath(abs: string, cwd: string, home: string): string {
  if (cwd && abs.startsWith(`${cwd}/`)) {
    return `./${relative(cwd, abs)}`
  }
  if (home && abs === home) return "~"
  if (home && abs.startsWith(`${home}/`)) {
    return `~/${relative(home, abs)}`
  }
  return abs
}

/** Clip a string to N chars, appending `…` when truncated. */
function clip(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n - 1).trimEnd()}…`
}

/** Render a 2D array as a GitHub-flavored markdown table. */
function renderMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) return ""
  // Pipe-escape any `|` inside cells.
  const escaped = rows.map((row) => row.map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " ")))
  const header = escaped[0]
  const out: string[] = []
  out.push(`| ${header.join(" | ")} |`)
  out.push(`| ${header.map(() => "---").join(" | ")} |`)
  for (let i = 1; i < escaped.length; i++) {
    out.push(`| ${escaped[i].join(" | ")} |`)
  }
  return out.join("\n")
}

// ---------------------------------------------------------------------------
// Loader entry point (default export)
// ---------------------------------------------------------------------------

/**
 * Default export: the prompt-fragment handler the loader will invoke at
 * session start. Reads user config, runs discovery, returns the
 * formatted markdown.
 *
 * Errors are caught and logged to ctx.stderr (so we don't break boot)
 * but result in an empty fragment.
 */
const handler: PromptFragmentHandler = (ctx: PromptFragmentContext): string => {
  try {
    const config = loadSkillsConfig()
    if (!config.enabled) return ""
    const result = discoverSkills(config, ctx.cwd, homedir())
    return renderFragment(result, ctx.cwd, homedir())
  } catch (e) {
    // Route through the structured diagnostic logger (file log + TUI
    // surface). `ctx.log` is auto-prefixed by the loader, so the
    // emitted source becomes `ma-skills.prompt-fragment`.
    try {
      ctx.log.error("prompt-fragment", (e as Error).message)
    } catch {
      // Logging itself must never break boot.
    }
    return ""
  }
}

export default handler
