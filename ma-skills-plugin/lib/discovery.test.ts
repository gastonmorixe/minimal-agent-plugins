/**
 * Tests for the skill discovery walker.
 *
 * Strategy: real filesystem under a tmpdir. Each test builds a small
 * fixture, runs discovery against an injected `cwd` / `home`, asserts on
 * the structured result.
 *
 * @module lib/discovery.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { defaultConfig, type SkillsConfig } from "./config.ts"
import {
  dirIdOf,
  discoverSkills,
  findSkill,
  listSiblings,
  resolveRoots,
  walkRoot,
} from "./discovery.ts"

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

let TMP: string

// The live host publishes MINIMAL_AGENT_HOME into the env, which would make the
// userAgent root honor the override instead of the injected `home`. Tests here
// assert against the injected-`home` fallback, so clear the override around each
// case (and restore it after) to keep them deterministic regardless of how the
// suite was launched. The override is exercised explicitly in its own test.
let SAVED_HOME_ENV: string | undefined

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ma-skills-discovery-"))
  SAVED_HOME_ENV = process.env.MINIMAL_AGENT_HOME
  delete process.env.MINIMAL_AGENT_HOME
})

afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true })
  if (SAVED_HOME_ENV === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = SAVED_HOME_ENV
})

function makeSkill(
  rootAbs: string,
  dirName: string,
  frontmatter: string,
  body: string = "",
): string {
  const dir = join(rootAbs, dirName)
  mkdirSync(dir, { recursive: true })
  const content = `---\n${frontmatter}\n---\n${body}`
  writeFileSync(join(dir, "SKILL.md"), content)
  return dir
}

/** Build a SkillsConfig with cwd/home derived from TMP. */
function configFor(opts: Partial<SkillsConfig> = {}): SkillsConfig {
  return { ...defaultConfig(), ...opts }
}

const TMP_CWD = () => join(TMP, "cwd")
const TMP_HOME = () => join(TMP, "home")

// ===========================================================================
// resolveRoots
// ===========================================================================

describe("resolveRoots", () => {
  test("all four roots when all enabled", () => {
    const cfg = configFor({
      roots: { project: true, projectClaudeCode: true, homeShared: true, userAgent: true },
    })
    const roots = resolveRoots(cfg, "/cwd", "/home")
    expect(roots.map((r) => r.scope)).toEqual([
      "project",
      "projectClaudeCode",
      "homeShared",
      "userAgent",
    ])
    expect(roots[0].path).toBe("/cwd/.agents/skills")
    expect(roots[1].path).toBe("/cwd/.claude/skills")
    expect(roots[2].path).toBe("/home/.agents/skills")
    expect(roots[3].path).toBe("/home/.minimal-agent/skills")
  })

  test("respects opt-outs", () => {
    const cfg = configFor({
      roots: { project: false, projectClaudeCode: false, homeShared: true, userAgent: false },
    })
    const roots = resolveRoots(cfg, "/cwd", "/home")
    expect(roots.map((r) => r.scope)).toEqual(["homeShared"])
  })

  test("extraRoots appended last", () => {
    const cfg = configFor({ extraRoots: ["/x/one", "/x/two"] })
    const roots = resolveRoots(cfg, "/cwd", "/home")
    expect(roots[roots.length - 1]).toEqual({ scope: "extra", path: "/x/two" })
    expect(roots[roots.length - 2]).toEqual({ scope: "extra", path: "/x/one" })
  })

  test("MINIMAL_AGENT_HOME relocates userAgent root but NOT homeShared", () => {
    // Dual-root split proof: a relocated MINIMAL_AGENT_HOME must win for the
    // `~/.minimal-agent/skills` (userAgent) root, while the `~/.agents/skills`
    // (homeShared) root is a DIFFERENT convention and must stay anchored to the
    // injected OS-home param, untouched by the override.
    const prev = process.env.MINIMAL_AGENT_HOME
    process.env.MINIMAL_AGENT_HOME = "/tmp/ma-reloc"
    try {
      const cfg = configFor({
        roots: { project: true, projectClaudeCode: true, homeShared: true, userAgent: true },
      })
      const roots = resolveRoots(cfg, "/cwd", "/home/u")
      const byScope = Object.fromEntries(roots.map((r) => [r.scope, r.path]))
      // userAgent honors the override...
      expect(byScope.userAgent).toBe("/tmp/ma-reloc/skills")
      // ...homeShared stays on the OS-home param (~/.agents, not ~/.minimal-agent).
      expect(byScope.homeShared).toBe("/home/u/.agents/skills")
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = prev
    }
  })

  test("without MINIMAL_AGENT_HOME, userAgent falls back to injected home", () => {
    const prev = process.env.MINIMAL_AGENT_HOME
    delete process.env.MINIMAL_AGENT_HOME
    try {
      const cfg = configFor({
        roots: { project: false, projectClaudeCode: false, homeShared: true, userAgent: true },
      })
      const roots = resolveRoots(cfg, "/cwd", "/home/u")
      const byScope = Object.fromEntries(roots.map((r) => [r.scope, r.path]))
      expect(byScope.userAgent).toBe("/home/u/.minimal-agent/skills")
      expect(byScope.homeShared).toBe("/home/u/.agents/skills")
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = prev
    }
  })
})

// ===========================================================================
// walkRoot
// ===========================================================================

describe("walkRoot", () => {
  test("missing root → empty result, no error", () => {
    const r = walkRoot({ scope: "project", path: join(TMP, "nope") }, { allowReservedNames: false })
    expect(r.ok).toEqual([])
    expect(r.broken).toEqual([])
  })

  test("valid skill discovered", () => {
    const root = join(TMP, "r")
    makeSkill(root, "alpha", `name: alpha\ndescription: One`)
    const r = walkRoot({ scope: "homeShared", path: root }, { allowReservedNames: false })
    expect(r.broken).toEqual([])
    expect(r.ok).toHaveLength(1)
    expect(r.ok[0].front.name).toBe("alpha")
    expect(r.ok[0].scope).toBe("homeShared")
    expect(r.ok[0].skillMdPath).toBe(join(root, "alpha", "SKILL.md"))
  })

  test("subdirectory without SKILL.md silently skipped", () => {
    const root = join(TMP, "r")
    mkdirSync(join(root, "empty-dir"), { recursive: true })
    makeSkill(root, "alpha", `name: alpha\ndescription: One`)
    const r = walkRoot({ scope: "project", path: root }, { allowReservedNames: false })
    expect(r.ok).toHaveLength(1)
    expect(r.broken).toHaveLength(0)
  })

  test("dot directories skipped", () => {
    const root = join(TMP, "r")
    makeSkill(root, ".hidden", `name: hidden\ndescription: X`)
    makeSkill(root, "visible", `name: visible\ndescription: X`)
    const r = walkRoot({ scope: "project", path: root }, { allowReservedNames: false })
    expect(r.ok.map((s) => s.front.name)).toEqual(["visible"])
  })

  test("non-directory entries skipped", () => {
    const root = join(TMP, "r")
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "README.md"), "hi")
    makeSkill(root, "alpha", `name: alpha\ndescription: X`)
    const r = walkRoot({ scope: "project", path: root }, { allowReservedNames: false })
    expect(r.ok.map((s) => s.front.name)).toEqual(["alpha"])
  })

  test("malformed SKILL.md reported as broken", () => {
    const root = join(TMP, "r")
    const dir = join(root, "bad")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter here")
    const r = walkRoot({ scope: "project", path: root }, { allowReservedNames: false })
    expect(r.ok).toEqual([])
    expect(r.broken).toHaveLength(1)
    expect(r.broken[0].dirName).toBe("bad")
    expect(r.broken[0].errors.length).toBeGreaterThan(0)
  })

  test("name/dir mismatch reported as broken", () => {
    const root = join(TMP, "r")
    makeSkill(root, "actual-dir", `name: other-name\ndescription: X`)
    const r = walkRoot({ scope: "project", path: root }, { allowReservedNames: false })
    expect(r.ok).toEqual([])
    expect(r.broken).toHaveLength(1)
    expect(r.broken[0].errors.join("|")).toMatch(/parent directory/i)
  })

  test("results sorted alphabetically (deterministic prompt-cache)", () => {
    const root = join(TMP, "r")
    makeSkill(root, "zeta", `name: zeta\ndescription: Z`)
    makeSkill(root, "alpha", `name: alpha\ndescription: A`)
    makeSkill(root, "mike", `name: mike\ndescription: M`)
    const r = walkRoot({ scope: "project", path: root }, { allowReservedNames: false })
    expect(r.ok.map((s) => s.front.name)).toEqual(["alpha", "mike", "zeta"])
  })

  test("reserved name 'claude' rejected by default", () => {
    const root = join(TMP, "r")
    makeSkill(root, "claude-helper", `name: claude-helper\ndescription: X`)
    const r = walkRoot({ scope: "project", path: root }, { allowReservedNames: false })
    expect(r.ok).toEqual([])
    expect(r.broken).toHaveLength(1)
  })

  test("reserved name accepted when allowReservedNames=true", () => {
    const root = join(TMP, "r")
    makeSkill(root, "claude-helper", `name: claude-helper\ndescription: X`)
    const r = walkRoot({ scope: "project", path: root }, { allowReservedNames: true })
    expect(r.ok).toHaveLength(1)
    expect(r.broken).toEqual([])
  })
})

// ===========================================================================
// discoverSkills — precedence + dedup
// ===========================================================================

describe("discoverSkills — precedence + dedup", () => {
  test("higher-precedence root shadows lower", () => {
    const cwd = TMP_CWD()
    const home = TMP_HOME()
    const projectRoot = join(cwd, ".agents", "skills")
    const homeRoot = join(home, ".agents", "skills")
    const userAgentRoot = join(home, ".minimal-agent", "skills")
    makeSkill(projectRoot, "alpha", `name: alpha\ndescription: project version`)
    makeSkill(homeRoot, "alpha", `name: alpha\ndescription: home version`)
    makeSkill(userAgentRoot, "beta", `name: beta\ndescription: user version`)

    const r = discoverSkills(defaultConfig(), cwd, home)
    expect(r.skills.map((s) => s.front.name)).toEqual(["alpha", "beta"])

    const alpha = findSkill(r, "alpha")!
    expect(alpha.scope).toBe("project")
    expect(alpha.front.description).toBe("project version")

    expect(r.shadowed).toHaveLength(1)
    expect(r.shadowed[0].skill.scope).toBe("homeShared")
    expect(r.shadowed[0].shadowedBy).toBe("project")
  })

  test("broken skills surfaced separately from winners", () => {
    const cwd = TMP_CWD()
    const home = TMP_HOME()
    const userAgentRoot = join(home, ".minimal-agent", "skills")
    makeSkill(userAgentRoot, "good", `name: good\ndescription: A`)
    const badDir = join(userAgentRoot, "bad")
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, "SKILL.md"), "no fm")
    const r = discoverSkills(defaultConfig(), cwd, home)
    expect(r.skills.map((s) => s.front.name)).toEqual(["good"])
    expect(r.broken).toHaveLength(1)
    expect(r.broken[0].dirName).toBe("bad")
  })

  test("maxSkills trims overflow", () => {
    const cwd = TMP_CWD()
    const home = TMP_HOME()
    const root = join(home, ".minimal-agent", "skills")
    for (const n of ["a", "b", "c", "d", "e"]) {
      makeSkill(root, `s-${n}`, `name: s-${n}\ndescription: ${n}`)
    }
    const r = discoverSkills({ ...defaultConfig(), maxSkills: 3 }, cwd, home)
    expect(r.skills).toHaveLength(3)
  })

  test("projectClaudeCode opt-in scans .claude/skills", () => {
    const cwd = TMP_CWD()
    const home = TMP_HOME()
    const ccRoot = join(cwd, ".claude", "skills")
    makeSkill(ccRoot, "cc-skill", `name: cc-skill\ndescription: hi`)

    const off = discoverSkills(defaultConfig(), cwd, home)
    expect(off.skills.map((s) => s.front.name)).toEqual([])

    const onCfg = { ...defaultConfig() }
    onCfg.roots = { ...onCfg.roots, projectClaudeCode: true }
    const on = discoverSkills(onCfg, cwd, home)
    expect(on.skills.map((s) => s.front.name)).toEqual(["cc-skill"])
    expect(on.skills[0].scope).toBe("projectClaudeCode")
  })

  test("extraRoots discovered, lowest precedence", () => {
    const cwd = TMP_CWD()
    const home = TMP_HOME()
    const extraRoot = join(TMP, "extra-skills")
    makeSkill(extraRoot, "ext", `name: ext\ndescription: extra`)
    makeSkill(extraRoot, "alpha", `name: alpha\ndescription: extra-alpha`)
    const userAgentRoot = join(home, ".minimal-agent", "skills")
    makeSkill(userAgentRoot, "alpha", `name: alpha\ndescription: user-alpha`)

    const r = discoverSkills({ ...defaultConfig(), extraRoots: [extraRoot] }, cwd, home)
    expect(r.skills.map((s) => s.front.name).sort()).toEqual(["alpha", "ext"])
    // alpha should resolve to user-agent (higher precedence), not extra.
    expect(findSkill(r, "alpha")!.scope).toBe("userAgent")
    expect(r.shadowed.find((s) => s.skill.front.name === "alpha")?.skill.scope).toBe("extra")
  })

  test("empty world → empty result", () => {
    const r = discoverSkills(defaultConfig(), TMP_CWD(), TMP_HOME())
    expect(r.skills).toEqual([])
    expect(r.broken).toEqual([])
    expect(r.shadowed).toEqual([])
  })
})

// ===========================================================================
// listSiblings + dirIdOf
// ===========================================================================

describe("listSiblings", () => {
  test("returns top-level entries excluding SKILL.md and dotfiles", () => {
    const home = TMP_HOME()
    const root = join(home, ".minimal-agent", "skills")
    const dir = makeSkill(root, "demo", `name: demo\ndescription: D`)
    mkdirSync(join(dir, "scripts"))
    mkdirSync(join(dir, "references"))
    writeFileSync(join(dir, "README.md"), "hi")
    writeFileSync(join(dir, ".hidden"), "x")
    const r = discoverSkills(defaultConfig(), TMP_CWD(), home)
    const siblings = listSiblings(r.skills[0])
    expect(siblings).toEqual(["README.md", "references", "scripts"])
  })

  test("returns [] when dir is unreadable / gone", () => {
    expect(
      listSiblings({
        front: { name: "x", description: "x" },
        dir: "/nope-/----",
        skillMdPath: "/nope-/----/SKILL.md",
        scope: "userAgent",
      }),
    ).toEqual([])
  })
})

describe("dirIdOf", () => {
  test("returns basename of an absolute path", () => {
    expect(dirIdOf("/a/b/c/my-skill")).toBe("my-skill")
  })
})
