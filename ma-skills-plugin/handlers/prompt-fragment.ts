/**
 * Prompt-fragment producer for the ma-skills plugin.
 *
 * Emitted into the system prompt at session start by minimal-agent's
 * plugin loader. Implements **Level 1** of the Agent Skills progressive-
 * disclosure model: just the `name` and a clipped `description` of each
 * discovered skill, so the model knows what's available without paying
 * the token cost of every SKILL.md body up front.
 *
 * Output shape (markdown):
 *
 *   ## Skills available this session
 *
 *   Use `Skill` with `read` and the name of a skill to load it. A skill
 *   is at `<root>/<name>/SKILL.md`.
 *
 *   ### `~/.agents/skills`
 *
 *   - name: clipped description
 *
 *   Skills not shown here: 7. `Skill` with `list` shows all skills.
 *
 * The fixed text is in `prompts/catalog-intro.md` and `prompts/catalog-cap.md`
 * (`%%count%%` var). Skill names and descriptions are user data and stay in
 * code.
 *
 * One `###` heading per skills root (the parent directory of each skill
 * directory), in discovery order. The cap line shows only when
 * `maxSkills` hid skills. Broken and shadowed skills are not in the
 * prompt: the `Skill` `list` action gives them, and broken skills also
 * emit a `skill-load` warning for the user.
 *
 * When discovery finds zero valid skills, the producer returns the empty
 * string. The loader treats empty fragments as "skip", so the system
 * prompt stays clean.
 *
 * @module handlers/prompt-fragment
 */

import { homedir } from "node:os"
import { dirname, relative } from "node:path"

import { loadSkillsConfig } from "../lib/config.ts"
import { capSkillsForPrompt, discoverSkills } from "../lib/discovery.ts"
import { warnBrokenSkills, warnSkillCatalogCap } from "../lib/report-broken.ts"
import type {
  DiscoveryResult,
  PromptFragmentContext,
  PromptFragmentHandler,
  Skill,
} from "../lib/types.ts"
// Text imports: Bun inlines the files, so the same code works in a compiled
// binary. The STE gate reads the fixed words in `prompts/*.md`.
import catalogCapMd from "../prompts/catalog-cap.md" with { type: "text" }
import catalogIntroMd from "../prompts/catalog-intro.md" with { type: "text" }

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on the Level-1 catalog even if config.maxSkills is set high.
 */
const MAX_FRAGMENT_ENTRIES = 128

/**
 * Cap on the `description` chunk we render per row. Spec allows up to
 * 1024; we already validate that. The L1 fragment is meant to be a
 * router, not the full doc, so a short clip keeps token cost down.
 * 120 keeps most "Use when" text. Model can `Skill info` to get the
 * full description verbatim.
 */
const DESC_CLIP = 120

// ---------------------------------------------------------------------------
// Pure renderers (exported for tests)
// ---------------------------------------------------------------------------

/** Optional Level-1 cap note. `maxSkills` hid these packs from the catalog. */
export interface CatalogCapNote {
  /** How many valid skills were left out of the Level-1 catalog. */
  omittedCount: number
  /** Config cap that produced the omission. */
  maxSkills: number
}

/**
 * Render the full fragment from a discovery result + cwd/home (for path
 * shortening). Pure. Exported so tests can drive it without mocking the
 * config / fs.
 */
export function renderFragment(
  result: DiscoveryResult,
  cwd: string = process.cwd(),
  home: string = homedir(),
  cap?: CatalogCapNote,
): string {
  if (result.skills.length === 0) {
    // Nothing to say. Broken skills alone give no section.
    return ""
  }

  const lines: string[] = []
  lines.push(catalogIntroMd.trim())
  lines.push("")
  lines.push(renderCatalog(result.skills, cwd, home))
  lines.push("")

  if (cap && cap.omittedCount > 0) {
    lines.push(fill(catalogCapMd.trim(), { count: String(cap.omittedCount) }))
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

/**
 * Render the skills catalog: one `###` heading per root, then one
 * `- name: description` row per skill.
 *
 * The root is the parent directory of the skill directory (the skill
 * name equals its directory name). Roots keep the order of their first
 * appearance in `skills`. `capSkillsForPrompt` slices in walk order, so
 * a root is usually contiguous. If an `extra` root is interleaved, its
 * skills still group under the first heading of that root.
 */
export function renderCatalog(skills: Skill[], cwd: string, home: string): string {
  const groups = new Map<string, string[]>()
  for (const s of skills.slice(0, MAX_FRAGMENT_ENTRIES)) {
    const root = shortenPath(dirname(s.dir), cwd, home)
    const desc = clip(s.front.description.replace(/\s*\n\s*/g, " "), DESC_CLIP)
    const row = `- ${s.front.name}: ${desc}`
    const rows = groups.get(root)
    if (rows) rows.push(row)
    else groups.set(root, [row])
  }
  const out: string[] = []
  for (const [root, rows] of groups) {
    if (out.length > 0) out.push("")
    out.push(`### \`${root}\``)
    out.push("")
    out.push(...rows)
  }
  return out.join("\n")
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

/**
 * Fill the `%%name%%` vars of a prompt text in one pass. A value is not read
 * again as a template. An unknown var stays as written.
 */
function fill(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(/%%([A-Za-z0-9_]+)%%/g, (m, key: string) => vars[key] ?? m)
}

/** Clip a string to N chars, appending `…` when truncated. */
function clip(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n - 1).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// Loader entry point (default export)
// ---------------------------------------------------------------------------

/**
 * Default export: the prompt-fragment handler the loader will invoke at
 * session start. Reads user config, runs discovery, returns the
 * formatted markdown.
 *
 * Errors are caught and logged on `ctx.log` (so we don't break boot)
 * but result in an empty fragment. Broken skills also emit `ctx.log.warn`
 * (`skill-load`) so core can show the last-warn slot. Overflow past
 * `maxSkills` emits `skill-catalog` and is omitted from this catalog only.
 */
const handler: PromptFragmentHandler = (ctx: PromptFragmentContext): string => {
  try {
    const config = loadSkillsConfig()
    if (!config.enabled) return ""
    const result = discoverSkills(config, ctx.cwd, homedir())
    warnBrokenSkills(ctx.log, result.broken)
    const { catalog, omitted } = capSkillsForPrompt(result.skills, config.maxSkills)
    warnSkillCatalogCap(ctx.log, omitted, config.maxSkills)
    return renderFragment(
      { ...result, skills: catalog },
      ctx.cwd,
      homedir(),
      omitted.length > 0
        ? { omittedCount: omitted.length, maxSkills: config.maxSkills }
        : undefined,
    )
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
