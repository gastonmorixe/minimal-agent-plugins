/**
 * Tests for `warnBrokenSkills`.
 *
 * @module lib/report-broken.test
 */

import { describe, expect, test } from "bun:test"

import {
  BROKEN_SKILL_LOG_SOURCE,
  CATALOG_CAP_LOG_SOURCE,
  warnBrokenSkills,
  warnSkillCatalogCap,
} from "./report-broken.ts"
import type { BrokenSkill, PluginLogger, Skill } from "./types.ts"

interface WarnCall {
  source: string
  message: string
  sd?: Record<string, unknown>
}

function makeLog(opts?: { throwOnWarn?: boolean }): {
  log: PluginLogger
  warns: WarnCall[]
} {
  const warns: WarnCall[] = []
  const noop = () => {}
  const log: PluginLogger = {
    emergency: noop,
    alert: noop,
    critical: noop,
    error: noop,
    warn(source, message, sd) {
      if (opts?.throwOnWarn) throw new Error("logger down")
      warns.push({ source, message, sd })
    },
    notice: noop,
    info: noop,
    debug: noop,
  }
  return { log, warns }
}

function broken(over: Partial<BrokenSkill> & { dirName: string }): BrokenSkill {
  return {
    dirName: over.dirName,
    dir: over.dir ?? `/skills/${over.dirName}`,
    scope: over.scope ?? "homeShared",
    errors: over.errors ?? ["frontmatter field `description` exceeds 1024 characters (got 1730)"],
  }
}

describe("warnBrokenSkills", () => {
  test("no-op when the broken list is empty", () => {
    const { log, warns } = makeLog()
    warnBrokenSkills(log, [])
    expect(warns).toEqual([])
  })

  test("one warn per broken skill, with name and first reason", () => {
    const { log, warns } = makeLog()
    warnBrokenSkills(log, [
      broken({ dirName: "transitions-dev" }),
      broken({
        dirName: "other",
        errors: ["missing closing ---", "name mismatch"],
      }),
    ])
    expect(warns).toHaveLength(2)
    expect(warns[0].source).toBe(BROKEN_SKILL_LOG_SOURCE)
    expect(warns[0].message).toBe(
      'skill "transitions-dev" not loaded: frontmatter field `description` exceeds 1024 characters (got 1730)',
    )
    expect(warns[0].sd).toEqual({
      name: "transitions-dev",
      dir: "/skills/transitions-dev",
      scope: "homeShared",
      reason: "frontmatter field `description` exceeds 1024 characters (got 1730)",
      errorCount: 1,
    })
    expect(warns[1].message).toBe('skill "other" not loaded: missing closing --- (+1 more)')
    expect(warns[1].sd?.errorCount).toBe(2)
  })

  test("unknown error when the errors array is empty", () => {
    const { log, warns } = makeLog()
    warnBrokenSkills(log, [broken({ dirName: "empty", errors: [] })])
    expect(warns[0].message).toBe('skill "empty" not loaded: unknown error')
    expect(warns[0].sd?.reason).toBe("unknown error")
    expect(warns[0].sd?.errorCount).toBe(0)
  })

  test("swallows logger throws so boot continues", () => {
    const { log } = makeLog({ throwOnWarn: true })
    expect(() => warnBrokenSkills(log, [broken({ dirName: "x" })])).not.toThrow()
  })
})

function skill(name: string): Skill {
  return {
    front: { name, description: name },
    dir: `/skills/${name}`,
    skillMdPath: `/skills/${name}/SKILL.md`,
    scope: "homeShared",
  }
}

describe("warnSkillCatalogCap", () => {
  test("no-op when nothing was omitted", () => {
    const { log, warns } = makeLog()
    warnSkillCatalogCap(log, [], 64)
    expect(warns).toEqual([])
  })

  test("one warn with count, sample names, and maxSkills", () => {
    const { log, warns } = makeLog()
    warnSkillCatalogCap(log, [skill("transitions-dev"), skill("other")], 64)
    expect(warns).toHaveLength(1)
    expect(warns[0].source).toBe(CATALOG_CAP_LOG_SOURCE)
    expect(warns[0].message).toContain("capped at 64")
    expect(warns[0].message).toContain("omitted 2")
    expect(warns[0].message).toContain("transitions-dev")
    expect(warns[0].message).toContain("Skill list/info/read still resolve them")
    expect(warns[0].sd).toEqual({
      maxSkills: 64,
      omittedCount: 2,
      omitted: "transitions-dev,other",
    })
  })

  test("swallows logger throws so boot continues", () => {
    const { log } = makeLog({ throwOnWarn: true })
    expect(() => warnSkillCatalogCap(log, [skill("x")], 1)).not.toThrow()
  })
})
