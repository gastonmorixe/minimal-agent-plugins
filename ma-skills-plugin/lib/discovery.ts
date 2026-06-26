/**
 * Skill discovery across roots.
 *
 * Walks the configured roots in precedence order (closer-to-user wins),
 * reads each candidate `<root>/<name>/SKILL.md`, validates the
 * frontmatter, and deduplicates by `name`. Shadowed skills and parse
 * failures are surfaced separately so the prompt-fragment and the
 * `Skill list` action can show them.
 *
 * Precedence (highest first):
 *   1. project           — <cwd>/.agents/skills/
 *   2. projectClaudeCode — <cwd>/.claude/skills/        (opt-in)
 *   3. homeShared        — ~/.agents/skills/
 *   4. userAgent         — ~/.minimal-agent/skills/
 *   5. extra             — config.extraRoots (lowest)
 *
 * Walk is one level deep: each immediate subdirectory of a root that
 * contains a readable SKILL.md is considered a skill candidate.
 *
 * IO is synchronous (`readdirSync` + `readFileSync`). Discovery runs
 * once at session start in the prompt-fragment, and on-demand for
 * `Skill list` — both are fine to block briefly.
 *
 * @module lib/discovery
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

import { agentHome } from "./agent-home.ts"
import type { SkillsConfig } from "./config.ts"
import { parseSkillMd } from "./skill-md.ts"
import type { BrokenSkill, DiscoveryResult, Skill, SkillScope } from "./types.ts"

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

export interface ResolvedRoot {
  /** Stable scope tag. */
  scope: SkillScope
  /** Absolute path. */
  path: string
}

/**
 * Resolve enabled roots into absolute paths in precedence order.
 *
 * `cwd` is split out so tests can drive discovery from a tmpdir without
 * mutating `process.cwd()`. `home` is split out for the same reason.
 */
export function resolveRoots(
  config: SkillsConfig,
  cwd: string = process.cwd(),
  home: string = homedir(),
): ResolvedRoot[] {
  const roots: ResolvedRoot[] = []
  if (config.roots.project) {
    roots.push({ scope: "project", path: join(cwd, ".agents", "skills") })
  }
  if (config.roots.projectClaudeCode) {
    roots.push({ scope: "projectClaudeCode", path: join(cwd, ".claude", "skills") })
  }
  if (config.roots.homeShared) {
    roots.push({ scope: "homeShared", path: join(home, ".agents", "skills") })
  }
  if (config.roots.userAgent) {
    // `~/.minimal-agent/skills/`, honoring a relocated MINIMAL_AGENT_HOME. The
    // injected `home` stays the fallback base, so absent the override this is
    // exactly `join(home, ".minimal-agent", "skills")` as before. Note the
    // homeShared root above stays on `~/.agents` (a DIFFERENT convention) and
    // must remain based on the OS-home param, unaffected by the override.
    roots.push({ scope: "userAgent", path: join(agentHome(process.env, home), "skills") })
  }
  for (const extra of config.extraRoots) {
    roots.push({ scope: "extra", path: extra })
  }
  return roots
}

// ---------------------------------------------------------------------------
// Walk one root
// ---------------------------------------------------------------------------

interface RootWalkResult {
  ok: Skill[]
  broken: BrokenSkill[]
}

/**
 * Walk a single root. Each immediate subdirectory containing a readable
 * SKILL.md becomes a candidate. Failure modes:
 *
 *   - root doesn't exist                 → empty result, no diagnostic
 *   - dir without SKILL.md               → silently skipped
 *   - SKILL.md unreadable                → BrokenSkill with IO error
 *   - SKILL.md parse failure             → BrokenSkill with errors
 *   - name in frontmatter ≠ dir name     → BrokenSkill (per spec)
 *
 * Sub-subdirectories are NOT recursed.
 */
export function walkRoot(
  root: ResolvedRoot,
  opts: { allowReservedNames: boolean },
): RootWalkResult {
  const ok: Skill[] = []
  const broken: BrokenSkill[] = []

  if (!existsSync(root.path)) return { ok, broken }

  let entries: string[]
  try {
    entries = readdirSync(root.path)
  } catch {
    return { ok, broken } // unreadable root, treat as empty
  }

  // Sort for deterministic ordering — discovery results feed into
  // system-prompt text, and a stable order makes prompt-cache hits.
  entries.sort()

  for (const name of entries) {
    if (name.startsWith(".")) continue // skip dotfiles / dotdirs
    const dir = join(root.path, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(dir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue

    const skillMd = join(dir, "SKILL.md")
    if (!existsSync(skillMd)) continue

    let text: string
    try {
      text = readFileSync(skillMd, "utf-8")
    } catch (e) {
      broken.push({
        dirName: name,
        dir,
        scope: root.scope,
        errors: [`could not read SKILL.md: ${(e as Error).message}`],
      })
      continue
    }

    const parsed = parseSkillMd(text, {
      expectedDirName: name,
      allowReservedNames: opts.allowReservedNames,
    })

    if (!parsed.ok) {
      broken.push({
        dirName: name,
        dir,
        scope: root.scope,
        errors: parsed.errors.map((e) => e.message),
      })
      continue
    }

    ok.push({
      front: parsed.value.front,
      dir,
      skillMdPath: skillMd,
      scope: root.scope,
    })
  }

  return { ok, broken }
}

// ---------------------------------------------------------------------------
// Walk all roots + deduplicate
// ---------------------------------------------------------------------------

/**
 * Run discovery across every enabled root.
 *
 * Precedence: roots earlier in `resolveRoots`'s output win. When two
 * roots both contain a skill with the same `name`, the higher-precedence
 * one is kept and the lower-precedence one is reported in `shadowed`.
 *
 * `maxSkills` clamps the total. Skills past the cap are dropped silently
 * — the prompt-fragment / `Skill list` can decide whether to surface a
 * warning to the user.
 */
export function discoverSkills(
  config: SkillsConfig,
  cwd: string = process.cwd(),
  home: string = homedir(),
): DiscoveryResult {
  const roots = resolveRoots(config, cwd, home)
  const skills: Skill[] = []
  const broken: BrokenSkill[] = []
  const shadowed: Array<{ skill: Skill; shadowedBy: SkillScope }> = []
  const byName = new Map<string, Skill>()

  for (const root of roots) {
    const { ok, broken: rootBroken } = walkRoot(root, {
      allowReservedNames: config.allowReservedNames,
    })
    broken.push(...rootBroken)
    for (const s of ok) {
      const winner = byName.get(s.front.name)
      if (winner) {
        // Lower-precedence; shadowed by `winner`.
        shadowed.push({ skill: s, shadowedBy: winner.scope })
      } else {
        byName.set(s.front.name, s)
        skills.push(s)
      }
    }
  }

  // Apply maxSkills cap to keep prompt overhead bounded.
  const trimmed = skills.slice(0, config.maxSkills)
  return { skills: trimmed, broken, shadowed }
}

/** Convenience: lookup a skill by name in a discovery result. */
export function findSkill(result: DiscoveryResult, name: string): Skill | null {
  for (const s of result.skills) {
    if (s.front.name === name) return s
  }
  return null
}

/**
 * Best-effort "what files are bundled with this skill?" listing.
 *
 * Returns sibling top-level entries inside the skill's directory,
 * excluding SKILL.md itself. Dotfiles are excluded. Used by `Skill read`
 * to tell the model what other resources it can `Read` next.
 *
 * Exported standalone so the handler can populate the read-action's
 * trailer without depending on the full discovery machinery.
 */
export function listSiblings(skill: Skill): string[] {
  let entries: string[]
  try {
    entries = readdirSync(skill.dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    if (name === "SKILL.md") continue
    if (name.startsWith(".")) continue
    out.push(name)
  }
  out.sort()
  return out
}

/** Use the directory basename as a fallback id when frontmatter is broken. */
export function dirIdOf(path: string): string {
  return basename(path)
}
