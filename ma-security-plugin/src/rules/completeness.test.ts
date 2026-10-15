// Completeness test (J section 1). Scans rule folders with fs at test time only.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { hasCredit } from "./credits.ts"
import { ALIASES, CMD_RULES, PATH_RULES, REDACT_RULES } from "./index.ts"
import type { AnyRule } from "./types.ts"

const RULES_DIR = import.meta.dir
const FAMILIES = ["secret", "pii", "path", "cmd"] as const
const ID_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/

const ALL: readonly AnyRule[] = [...REDACT_RULES, ...PATH_RULES, ...CMD_RULES]

function ruleFiles(): { family: string; id: string; file: string }[] {
  const out: { family: string; id: string; file: string }[] = []
  for (const family of FAMILIES) {
    const dir = join(RULES_DIR, family)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue
      out.push({ family, id: name.slice(0, -3), file: join(dir, name) })
    }
  }
  return out
}

function sorted(ids: readonly string[]): boolean {
  for (let i = 1; i < ids.length; i++)
    if ((ids[i - 1] as string) >= (ids[i] as string)) return false
  return true
}

describe("rule index completeness", () => {
  const indexSrc = readFileSync(join(RULES_DIR, "index.ts"), "utf8")

  it("every rule file is imported by the index, and every entry has a file", async () => {
    const files = ruleFiles()
    const liveIds = new Set(ALL.map((r) => r.id))
    for (const f of files) {
      expect(indexSrc.includes(`./${f.family}/${f.id}.ts`)).toBe(true)
      const mod = (await import(f.file)) as { default?: AnyRule }
      expect(mod.default?.id).toBe(f.id)
      expect(liveIds.has(f.id)).toBe(true)
    }
    const fileIds = new Set(files.map((f) => f.id))
    for (const r of ALL) expect(fileIds.has(r.id)).toBe(true)
  })

  it("id equals file name and family equals folder", () => {
    const byId = new Map(ruleFiles().map((f) => [f.id, f.family]))
    for (const r of ALL) expect(byId.get(r.id)).toBe(r.family)
  })

  it("ids are unique and well formed", () => {
    const ids = ALL.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(ID_RE.test(id)).toBe(true)
    for (const r of ALL) expect(r.id.startsWith(`${r.family}.`)).toBe(true)
  })

  it("each family array is sorted by id", () => {
    expect(sorted(REDACT_RULES.map((r) => r.id))).toBe(true)
    expect(sorted(PATH_RULES.map((r) => r.id))).toBe(true)
    expect(sorted(CMD_RULES.map((r) => r.id))).toBe(true)
  })

  it("alias targets exist and no alias equals a live id", () => {
    const live = new Set(ALL.map((r) => r.id))
    for (const [from, to] of Object.entries(ALIASES)) {
      expect(ID_RE.test(from)).toBe(true)
      expect(live.has(to)).toBe(true)
      expect(live.has(from)).toBe(false)
    }
  })

  it("every inspiredBy has a credits row", () => {
    for (const r of ALL) {
      if (r.inspiredBy) expect(hasCredit(r.inspiredBy.tool, r.inspiredBy.ruleId)).toBe(true)
    }
  })

  it("every rule has a one-line explain of 120 chars or less", () => {
    for (const r of ALL) {
      expect(r.explain.length).toBeGreaterThan(0)
      expect(r.explain.length).toBeLessThanOrEqual(120)
      expect(/[\r\n]/.test(r.explain)).toBe(false)
    }
  })
})
