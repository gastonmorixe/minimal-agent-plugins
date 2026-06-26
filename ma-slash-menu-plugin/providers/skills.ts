/**
 * Skills provider — discovers SKILL.md packs across the standard roots
 * and exposes each as a menu item with an approximate token cost.
 *
 * Discovery roots (in precedence order, closer-to-user wins):
 *   1. `<cwd>/.agents/skills/`        — project
 *   2. `~/.agents/skills/`            — home, shared with other agents
 *   3. `~/.minimal-agent/skills/`     — user, agent-specific
 *
 * For each pack we parse a *minimal* frontmatter slice: just `name` and
 * `description`. We deliberately do NOT activate a full YAML parser
 * here — provider startup must be cheap, and the menu only needs three
 * fields. Parse failure → entry marked `disabled: true` with the parse
 * error in `disabledReason`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

import { agentHome } from "../lib/paths.ts"
import { approxTokensForMany, defaultDeps, type TokenDeps } from "../lib/tokens.ts"
import type { Item, Provider } from "../lib/types.ts"

export interface SkillsDeps {
  /** Where to discover skills. Each entry is an *absolute* directory path. */
  roots: string[]
  /** Token-counter deps. Allows injecting an in-memory cache for tests. */
  tokens: TokenDeps
  /** Read directory entries. Returns subdir names. */
  readDir(path: string): string[]
  /** Read a file body. Returns null on miss. */
  readFile(path: string): string | null
  /** Stat a path. Returns null on miss. */
  stat(path: string): { isDirectory: boolean } | null
}

/** Default roots: project (cwd) → home → user. Skips roots that don't exist.
 *
 * The `.agents` roots use the OS-home `~/.agents` convention and stay on the
 * `home` param. The `.minimal-agent` user root routes through {@link agentHome}
 * so a host that relocated `MINIMAL_AGENT_HOME` is honored; absent the override
 * it yields `join(home, ".minimal-agent")`, identical to before, so injected-
 * `home` tests stay green. */
export function defaultRoots(
  cwd: string = process.cwd(),
  home: string = process.env.HOME ?? "/",
): string[] {
  return [
    resolve(cwd, ".agents", "skills"),
    resolve(home, ".agents", "skills"),
    resolve(agentHome(process.env, home), "skills"),
  ]
}

/** Default fs deps wired to real Node fs. */
export function defaultSkillsDeps(): SkillsDeps {
  return {
    roots: defaultRoots(),
    tokens: defaultDeps(),
    readDir: (p) => {
      try {
        return readdirSync(p)
      } catch {
        return []
      }
    },
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8")
      } catch {
        return null
      }
    },
    stat: (p) => {
      try {
        const s = statSync(p)
        return { isDirectory: s.isDirectory() }
      } catch {
        return null
      }
    },
  }
}

/**
 * Parse just `name` and `description` out of YAML frontmatter.
 *
 * Tolerant of: leading/trailing whitespace, quoted strings (`"…"` or
 * `'…'`), multi-line block scalars (`description: >` followed by
 * indented continuation lines until next key).
 *
 * Returns null when no frontmatter block is present (missing `---`
 * fence), which is treated as a parse failure.
 */
export function parseMinimalFrontmatter(
  body: string,
): { name?: string; description?: string; error?: string } | null {
  if (!body.startsWith("---")) return null
  const end = body.indexOf("\n---", 3)
  if (end < 0) return { error: "unterminated frontmatter (missing closing ---)" }
  const block = body.slice(3, end).trim()
  const lines = block.split("\n")
  const out: { name?: string; description?: string } = {}

  // Tokens we only care about at indent-0 (top-level keys).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]!
    let value = m[2]!.trim()
    if (key !== "name" && key !== "description") continue

    // Block scalar continuations (`description: >` / `description: |`).
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const parts: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!
        if (/^\S/.test(next)) break // unindented line → next key, stop
        parts.push(next.trim())
        i = j
      }
      value = parts.join(value.startsWith(">") ? " " : "\n").trim()
    } else {
      // Strip quotes if quoted.
      const q = value[0]
      if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) {
        value = value.slice(1, -1)
      }
    }

    out[key as "name" | "description"] = value
  }

  return out
}

/** Compress description to a single line, collapse whitespace runs. */
function flattenDescription(desc: string, maxChars = 200): string {
  const flat = desc.replace(/\s+/g, " ").trim()
  if (flat.length <= maxChars) return flat
  return flat.slice(0, maxChars - 1).trimEnd() + "…"
}

/** Build the items list from discovered skill directories. */
export function listSkills(deps: SkillsDeps): Item[] {
  const seenSlugs = new Set<string>()
  const items: Item[] = []
  const pathsForTokens: string[] = []
  const itemsByPath = new Map<string, Item>()

  for (const root of deps.roots) {
    const rootStat = deps.stat(root)
    if (!rootStat?.isDirectory) continue
    const entries = deps.readDir(root)
    for (const name of entries) {
      const dir = join(root, name)
      const dirStat = deps.stat(dir)
      if (!dirStat?.isDirectory) continue
      const skillPath = join(dir, "SKILL.md")
      const body = deps.readFile(skillPath)
      if (body === null) continue // not a skill pack

      const parsed = parseMinimalFrontmatter(body)
      let slug = name
      let description = ""
      let disabled = false
      let disabledReason: string | undefined

      if (parsed === null) {
        disabled = true
        disabledReason = "missing frontmatter"
      } else if (parsed.error) {
        disabled = true
        disabledReason = parsed.error
      } else {
        // Frontmatter `name` wins over directory name when present.
        if (parsed.name) slug = parsed.name
        description = parsed.description
          ? flattenDescription(parsed.description)
          : "(no description)"
      }

      // Skip lower-precedence duplicates.
      if (seenSlugs.has(slug)) continue
      seenSlugs.add(slug)

      const item: Item = {
        slug,
        description,
        category: "skl",
        disabled,
        disabledReason,
        payload: { skillPath, root, dir },
      }
      items.push(item)
      itemsByPath.set(skillPath, item)
      if (!disabled) pathsForTokens.push(skillPath)
    }
  }

  // Batch token counts.
  const tokenMap = approxTokensForMany(pathsForTokens, deps.tokens)
  for (const [path, tokens] of tokenMap) {
    const item = itemsByPath.get(path)
    if (item && tokens !== undefined) item.tokens = tokens
  }

  // Alphabetical by default (renderer re-sorts by score when query is set).
  items.sort((a, b) => a.slug.localeCompare(b.slug))
  return items
}

/**
 * Provider factory. Takes deps so tests can pass mock fs without
 * touching real disk.
 */
export function makeSkillsProvider(deps: SkillsDeps = defaultSkillsDeps()): Provider {
  return {
    id: "skills",
    list: () => listSkills(deps),
    refreshOn: ["skill.installed", "skill.removed", "skill.modified"],
  }
}

/** Default instance for plugin auto-loading. */
export const skillsProvider: Provider = makeSkillsProvider()

export default skillsProvider
