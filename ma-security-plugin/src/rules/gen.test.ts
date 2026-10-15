import { describe, expect, it } from "bun:test"

import { CHARSETS, fillExample, gen } from "./gen.ts"

describe("gen", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const g = { prefix: "zz-", len: 32, charset: "alnum" as const, seed: 42 }
    expect(gen(g)).toBe(gen(g))
    expect(gen(g)).not.toBe(gen({ ...g, seed: 43 }))
    expect(gen(g).length).toBe(35)
    expect(gen(g).startsWith("zz-")).toBe(true)
  })

  it("stays inside the charset and adds the suffix", () => {
    for (const cs of Object.keys(CHARSETS) as (keyof typeof CHARSETS)[]) {
      const v = gen({ len: 200, charset: cs, seed: 9, suffix: "!" })
      expect(v.endsWith("!")).toBe(true)
      for (const ch of v.slice(0, -1)) expect(CHARSETS[cs].includes(ch)).toBe(true)
    }
  })

  it("handles seed 0 and fills examples", () => {
    expect(gen({ len: 8, charset: "hex", seed: 0 }).length).toBe(8)
    const f = fillExample("a {{S}} b {{S}}", { len: 6, charset: "hex", seed: 3 })
    expect(f.text).toBe(`a ${f.secret} b ${f.secret}`)
  })
})
