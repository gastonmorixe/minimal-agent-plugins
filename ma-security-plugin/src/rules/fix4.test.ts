// B3 fix round 4: grouped overlap, multi-set hostile text, bench margins, stopwords.
import { describe, expect, it } from "bun:test"

import { loadRegistry } from "./registry.ts"
import {
  BENCH_MS_PER_MB,
  benchRule,
  benchSkipRetries,
  compileRedactRule,
  hostileText,
  hostileTexts,
  LOAD_BENCH_MS_PER_MB,
  selfTest,
  staticShapeCheck,
} from "./selftest.ts"
import type { Gen, RedactRule } from "./types.ts"

const OVER = "overlapping adjacent quantifiers"
// The review's exact rule: 512 digits take about 4.8 s on real input.
const DIGIT_BOMB = "(?:[0-9]{1,300})(?:[0-9]{1,300})(?:[0-9]{1,300})[A-Za-z!]?!"
const EMAIL = "[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\\.[A-Za-z]{2,24}"

const S = (seed: number, len = 20): Gen => ({ prefix: "zzq-tok-", len, charset: "alnum", seed })

const good: RedactRule = {
  id: "secret.test.good",
  family: "secret",
  kind: "test.good",
  severity: "high",
  gate: "keyword",
  keywords: ["zzq-tok-"],
  pattern: "\\bzzq-tok-[A-Za-z0-9]{20}(?=\\\\?['\"`]|[\\s;]|\\\\[nr]|$)",
  explain: "Synthetic test token.",
  render: { publicPrefix: "zzq-tok-", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [{ text: "key: {{S}}", secret: S(1) }],
    not_match: ["no token here", { text: "key: {{S}}", secret: S(3, 19) }],
  },
}

const compile = (r: RedactRule) => {
  const c = compileRedactRule(r)
  if (typeof c === "string") throw new Error(c)
  return c
}

describe("fix4 BLOCKER 1a overlap through groups", () => {
  for (const p of [
    "(?:[a-z]{1,40})(?:[a-z]{1,40})",
    "([a-z]{1,40})([a-z]{1,40})",
    "[a-z]{1,40}(?:-)?[a-z]{1,40}",
    "[a-z]{1,40}(?:x|y)?[a-z]{1,40}",
    "(?:x|[a-z]{1,9})[a-z]{1,9}",
    "(?:(?:[0-9]{1,9}))[0-9]{1,9}",
    DIGIT_BOMB,
  ]) {
    it(`flags ${p}`, () => {
      expect(staticShapeCheck(p)).toContain(OVER)
    })
  }
  for (const p of [
    "(?:[a-z]{1,40})(?:[0-9]{1,40})",
    "[a-z]{1,9}(?:-)[a-z]{1,9}",
    "[a-z]{1,9}(?:a[0-9]{1,3})",
    "(?:sk|pk)-[A-Za-z0-9]{20,40}",
    "[a-z]{1,9}(?:\\.|:)[a-z]{1,9}",
  ]) {
    it(`passes ${p}`, () => {
      expect(staticShapeCheck(p)).not.toContain(OVER)
    })
  }
})

describe("fix4 BLOCKER 1b one hostile text per variable char set", () => {
  const bomb: RedactRule = {
    id: "secret.test.digitbomb",
    family: "secret",
    kind: "test.digitbomb",
    severity: "low",
    gate: "always",
    keywords: [],
    pattern: DIGIT_BOMB,
    explain: "Synthetic catastrophic rule.",
    render: {},
    defaults: { status: "on", level: "mid" },
    examples: { match: ["123a!"], not_match: ["abc"] },
    notes: "always gate for the bench test. reviewed:overlap",
  }
  it("builds a digit filler text and a letter filler text", () => {
    const texts = hostileTexts(bomb, 64)
    expect(texts.length).toBe(2)
    expect(texts.some((t) => /^0{63}[^0-9A-Za-z!]$/.test(t))).toBe(true)
    for (const t of texts) expect(t.length).toBe(64)
  })
  it("hostileText is the first hostile text", () => {
    expect(hostileText(good, 100)).toBe(hostileTexts(good, 100)[0] as string)
  })
  it("caps the hostile texts at 8", () => {
    const sets = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]
    const p = sets.map((c) => `${c}{1,3}!`).join("")
    expect(hostileTexts({ ...good, pattern: p }, 64).length).toBeLessThanOrEqual(8)
  })
  it("the reviewed digit bomb passes the static check but the bench disables it", () => {
    expect(staticShapeCheck(DIGIT_BOMB, bomb.notes)).toEqual([])
    const t0 = performance.now()
    const r = loadRegistry({ sources: { redact: [good, bomb] } })
    const ms = performance.now() - t0
    expect(r.redact.map((c) => c.rule.id)).toEqual(["secret.test.good"])
    expect(r.disabled.map((d) => d.id)).toEqual(["secret.test.digitbomb"])
    expect(r.disabled[0]?.reason).toContain("bench")
    expect(ms).toBeLessThan(5000)
  })
})

describe("fix4 MAJOR 1 bench margins", () => {
  it("load gate is 5x looser than the CI gate", () => {
    expect(BENCH_MS_PER_MB).toBe(50)
    expect(LOAD_BENCH_MS_PER_MB).toBe(250)
  })
  it("skips retries only when best is over 10x budget AND over 50 ms", () => {
    expect(benchSkipRetries(6, 0.5)).toBe(false)
    expect(benchSkipRetries(49, 0.5)).toBe(false)
    expect(benchSkipRetries(51, 0.5)).toBe(true)
    expect(benchSkipRetries(60, 10)).toBe(false)
    expect(benchSkipRetries(101, 10)).toBe(true)
  })
  it("a realistic email-shape rule passes the load gate with margin", () => {
    const email: RedactRule = {
      id: "pii.test.email4",
      family: "pii",
      kind: "email",
      severity: "low",
      gate: "always",
      keywords: [],
      pattern: EMAIL,
      explain: "Synthetic email rule.",
      render: {},
      defaults: { status: "on", level: "mid" },
      examples: { match: ["mail a.b@example.invalid now"], not_match: ["no mail"] },
      notes: "always gate: no stable keyword. reviewed:overlap",
    }
    const b = benchRule(compile(email))
    expect(b.ok).toBe(true)
    // At least 2x margin under the load budget.
    expect(b.msPerMb * 2).toBeLessThan(LOAD_BENCH_MS_PER_MB)
  })
})

describe("fix4 MINOR 1 stopwords on a provider rule fail at compile", () => {
  const provider: RedactRule = { ...good, allow: ["stopwords"], allowStopwords: true }
  it("compileRedactRule rejects it", () => {
    const c = compileRedactRule(provider)
    expect(typeof c).toBe("string")
    expect(String(c)).toContain("allowStopwords")
  })
  it("skipSelfTest cannot bypass it", () => {
    const r = loadRegistry({ sources: { redact: [provider] }, skipSelfTest: true })
    expect(r.redact.length).toBe(0)
    expect(r.disabled.map((d) => d.id)).toEqual(["secret.test.good"])
  })
  it("selfTest still reports it", () => {
    const r = selfTest(provider)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("allowStopwords")
  })
})
