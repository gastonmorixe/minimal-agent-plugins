// Tests for the second B7 fix round (CAT warn/ask, ask outside strict, number canon).

import { describe, expect, test } from "bun:test"

import { CAT_IDS, KNOWN_IDS } from "./profiles.ts"
import { resolvePolicy, ruleSetting } from "./resolve.ts"

function dropped(spec: string): string[] {
  return resolvePolicy({ config: { spec } }).dropped.map((d) => d.clause)
}

describe("MAJOR 1 exact CAT id takes only on or off", () => {
  for (const id of CAT_IDS) {
    for (const word of ["warn", "ask"]) {
      for (const clause of [`${id}:${word}`, `${id}:status=${word}`]) {
        test(`${clause} is dropped, decision stays deny`, () => {
          for (const profile of ["steer", "guard", "strict"]) {
            const p = resolvePolicy({ config: { spec: `profile:${profile},${clause}` } })
            expect(p.floored).toBe(false)
            expect(ruleSetting(p, id).decision).toBe("deny")
            expect(ruleSetting(p, id).status).toBe("on")
            expect(p.dropped.map((d) => d.clause)).toContain(clause)
          }
        })
      }
      test(`JSON rules ${id}: ${word} is dropped`, () => {
        const p = resolvePolicy({ config: { rules: { [id]: { status: word } } } })
        expect(ruleSetting(p, id).decision).toBe("deny")
        expect(p.dropped.length).toBe(1)
      })
    }
    test(`${id}:off still turns only that id off`, () => {
      const p = resolvePolicy({ config: { spec: `${id}:off` } })
      expect(ruleSetting(p, id).decision).toBe("none")
      expect(p.dropped).toEqual([])
      for (const other of CAT_IDS) {
        if (other !== id) expect(ruleSetting(p, other).decision).toBe("deny")
      }
    })
    test(`${id}:on is kept`, () => {
      expect(dropped(`${id}:on`)).toEqual([])
    })
  }
})

const STATUSES = ["on", "warn", "off", "ask", "default"]
const TARGETS = [
  "*",
  "cmd",
  "path",
  "cmd.*",
  "path.*",
  "secret",
  "guard",
  "redactor",
  "entropy",
  "cmd.sudo",
  "cmd.disk.format",
]

function findAsk(v: unknown, at: string, out: string[]): void {
  if (v === "ask") out.push(at)
  else if (Array.isArray(v)) v.forEach((x, i) => findAsk(x, `${at}[${i}]`, out))
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) findAsk(x, `${at}.${k}`, out)
  }
}

describe("MINOR 3 no ask outside strict", () => {
  const ids = [...KNOWN_IDS, ...CAT_IDS, "cmd.newrule", "path.newrule"]
  for (const profile of ["steer", "guard"]) {
    test(`${profile}: sweep of statuses x targets has no ask field`, () => {
      const hits: string[] = []
      for (const t of TARGETS) {
        for (const s of STATUSES) {
          for (const spec of [
            `profile:${profile},${t}:status=${s}`,
            `profile:${profile},${t}:${s}`,
          ]) {
            const p = resolvePolicy({ config: { spec } })
            const { dropped: _d, rules, exported, ...rest } = p
            findAsk(rest, `${spec} policy`, hits)
            findAsk(rules.map, `${spec} map`, hits)
            if (exported.includes('"ask"')) hits.push(`${spec} exported`)
            for (const id of ids) findAsk(ruleSetting(p, id), `${spec} ${id}`, hits)
          }
        }
      }
      expect(hits).toEqual([])
    })
  }
  test("steer cmd.sudo:ask reports status warn, decision note", () => {
    const p = resolvePolicy({ config: { spec: "cmd.sudo:ask" } })
    expect(ruleSetting(p, "cmd.sudo").status).toBe("warn")
    expect(ruleSetting(p, "cmd.sudo").decision).toBe("note")
  })
  test("strict keeps ask", () => {
    const p = resolvePolicy({ config: { spec: "profile:strict,cmd.sudo:ask,guard:ask" } })
    expect(ruleSetting(p, "cmd.sudo").status).toBe("ask")
    expect(ruleSetting(p, "cmd.sudo").decision).toBe("ask")
    expect(p.features.guard.status).toBe("ask")
  })
  test("steer and guard ask equal warn (same hash)", () => {
    for (const profile of ["steer", "guard"]) {
      const a = resolvePolicy({ config: { spec: `profile:${profile},cmd.sudo:ask,redactor:ask` } })
      const w = resolvePolicy({
        config: { spec: `profile:${profile},cmd.sudo:warn,redactor:warn` },
      })
      expect(a.hash).toBe(w.hash)
    }
  })
  test("lead floor with ask in steer is read as warn", () => {
    const lead = JSON.stringify({
      v: 1,
      profile: "steer",
      layers: [{ depth: 0, targets: { "cmd.sudo": { status: ["ask"] } } }],
    })
    const p = resolvePolicy({ env: { MINIMAL_AGENT_SECURITY_RESOLVED: lead } })
    expect(ruleSetting(p, "cmd.sudo").status).toBe("warn")
    expect(p.exported.includes('"ask"')).toBe(false)
  })
})

describe("MINOR 4 hash canonical numbers", () => {
  test("4.5, 4.50 and 045e-1 give one canonical value", () => {
    const ps = ["4.5", "4.50", "045e-1"].map((n) =>
      resolvePolicy({ config: { spec: `entropy:threshold=${n}` } }),
    )
    for (const p of ps) {
      expect(p.dropped).toEqual([])
      expect(p.features.entropy.threshold).toBe(4.5)
      expect(p.exported).toContain('["4.5"]')
    }
    expect(ps[1]?.hash).toBe(ps[0]?.hash)
    expect(ps[2]?.hash).toBe(ps[0]?.hash)
  })
  test("JSON number 4.5 matches the spec string", () => {
    const a = resolvePolicy({ config: { rules: { entropy: { threshold: 4.5 } } } })
    const b = resolvePolicy({ config: { rules: { entropy: { threshold: "045e-1" } } } })
    expect(a.hash).toBe(b.hash)
  })
  test("out of range exponent is still dropped", () => {
    expect(dropped("entropy:threshold=1e9")).toEqual(["entropy:threshold=1e9"])
  })
})
