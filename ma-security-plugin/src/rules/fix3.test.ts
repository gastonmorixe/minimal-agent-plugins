// B3 fix round 3: overlap shape check, bench gate, example cap, gate notes, allowlists.
import { describe, expect, it } from "bun:test"

import { gen } from "./gen.ts"
import { loadRegistry } from "./registry.ts"
import {
  benchRule,
  compileRedactRule,
  EXAMPLE_CAP,
  hostileText,
  scanRule,
  selfTest,
  staticShapeCheck,
} from "./selftest.ts"
import type { Gen, RedactRule } from "./types.ts"

// Synthetic rules only. The prefix "zzq-tok-" is not a real provider format.
const S = (seed: number, len = 20): Gen => ({ prefix: "zzq-tok-", len, charset: "alnum", seed })
const body = (seed: number, len: number): string => gen({ len, charset: "alnum", seed })

const good: RedactRule = {
  id: "secret.test.good",
  family: "secret",
  kind: "test.good",
  severity: "high",
  gate: "keyword",
  keywords: ["zzq-tok-"],
  pattern: "\\bzzq-tok-[A-Za-z0-9]{20}(?=\\\\?['\"`]|[\\s;]|\\\\[nr]|$)",
  flags: "",
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

describe("fix3 MAJOR 1 overlapping adjacent quantifiers", () => {
  const OVER = "overlapping adjacent quantifiers"
  it("flags the O(n^4) chain of [a-z]{1,1000}", () => {
    expect(staticShapeCheck("[a-z]{1,1000}[a-z]{1,1000}[a-z]{1,1000}[a-z]{1,1000}!")).toContain(
      OVER,
    )
  })
  it("flags a single variable overlapping pair (budget is zero)", () => {
    expect(staticShapeCheck("[a-z]{1,40}[a-z0-9]{1,40}")).toContain(OVER)
    expect(staticShapeCheck("[a-z]{1,9}\\s?[a-z]{1,9}")).toContain(OVER)
  })
  it("keeps the reviewed:overlap opt-out", () => {
    expect(staticShapeCheck("[a-z]{1,40}[a-z0-9]{1,40}", "reviewed:overlap")).toEqual([])
  })
  for (const p of ["(\\w+\\s?)+$", "(a|a)+", "(.*a){12}", "(?:a{1,30}){1,30}b"]) {
    it(`still flags ${p} as nested`, () => {
      expect(staticShapeCheck(p)).toContain("nested quantifier")
    })
  }
  it("passes a prefix plus one bounded class, and a fixed-width sequence", () => {
    expect(staticShapeCheck("sk-[A-Za-z0-9_-]{20,40}")).toEqual([])
    expect(staticShapeCheck("[A-Z]{4}[0-9]{16}")).toEqual([])
    expect(staticShapeCheck("[a-z]{1,9}\\.[a-z]{1,9}")).toEqual([])
    expect(staticShapeCheck("[A-Z]{1,9}[0-9]{1,9}")).toEqual([])
  })
})

describe("fix3 MAJOR 2 example cap and bench gate", () => {
  it("fails a Gen len over the 8 KB cap without generating it", () => {
    const r = selfTest({
      ...good,
      examples: {
        match: [{ text: "key: {{S}}", secret: S(1, EXAMPLE_CAP + 1) }],
        not_match: [],
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("8192")
    const s = selfTest({
      ...good,
      examples: { match: ["x".repeat(EXAMPLE_CAP + 1)], not_match: [] },
    })
    expect(s.ok).toBe(false)
  })

  it("builds a hostile text from the pattern's widest class", () => {
    const t = hostileText(good, 1000)
    expect(t.length).toBe(1000)
    expect(t.startsWith("zzq-tok-")).toBe(true)
  })

  it("a normal rule passes the bench", () => {
    const b = benchRule(compile(good))
    expect(b.ok).toBe(true)
  })

  it("a catastrophic rule with a reviewed opt-out is disabled by the bench gate", () => {
    const bomb: RedactRule = {
      id: "secret.test.bomb",
      family: "secret",
      kind: "test.bomb",
      severity: "low",
      gate: "always",
      keywords: [],
      pattern: "[a-z]{1,1000}[a-z]{1,1000}[a-z]{1,1000}[a-z]{1,1000}!",
      explain: "Synthetic catastrophic rule.",
      render: {},
      defaults: { status: "on", level: "mid" },
      examples: { match: ["abcd!"], not_match: ["1234"] },
      notes: "always gate for the bench test. reviewed:overlap",
    }
    expect(staticShapeCheck(bomb.pattern as string, bomb.notes)).toEqual([])
    const t0 = performance.now()
    const r = loadRegistry({ sources: { redact: [good, bomb] } })
    const ms = performance.now() - t0
    expect(r.redact.map((c) => c.rule.id)).toEqual(["secret.test.good"])
    expect(r.disabled.map((d) => d.id)).toEqual(["secret.test.bomb"])
    expect(r.disabled[0]?.reason).toContain("bench")
    expect(ms).toBeLessThan(5000)
  })
})

describe("fix3 MINOR 2 every non-keyword gate needs notes", () => {
  const always: RedactRule = {
    ...good,
    id: "secret.test.always",
    gate: "always",
    keywords: [],
  }
  it("fails gate always without notes", () => {
    const r = selfTest(always)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("needs a reason in notes")
    expect(selfTest({ ...always, notes: "   " }).ok).toBe(false)
  })
  it("passes gate always with notes", () => {
    expect(selfTest({ ...always, notes: "no stable keyword" }).ok).toBe(true)
  })
})

describe("fix3 MINOR 5 allowlists never let a real token through", () => {
  const provider: RedactRule = {
    ...good,
    id: "secret.test.provider",
    pattern: "\\bzzq-tok-[A-Za-z0-9]{40}\\b",
    allow: ["placeholder", "gitleaks-global"],
  }
  it("a random 40-char token containing test is still redacted", () => {
    const value = `zzq-tok-${body(31, 18)}test${body(32, 18)}`
    expect(scanRule(compile(provider), `key: ${value} ;`).map((h) => h.value)).toEqual([value])
    const v2 = `zzq-tok-${body(33, 10)}Example${body(34, 23)}`
    expect(scanRule(compile(provider), `key: ${v2} ;`).length).toBe(1)
  })

  const kv: RedactRule = {
    ...good,
    id: "secret.test.kv",
    gate: "keyword",
    keywords: ["key"],
    pattern: "key=(\\S{4,60})",
    group: 1,
    render: {},
    allow: ["placeholder"],
  }
  it("words match the whole value, placeholders match the whole value", () => {
    const c = compile(kv)
    expect(scanRule(c, "key=changeme").length).toBe(0)
    expect(scanRule(c, "key=CHANGEME").length).toBe(0)
    expect(scanRule(c, "key=<your-token>").length).toBe(0)
    expect(scanRule(c, "key=${API_KEY}").length).toBe(0)
    expect(scanRule(c, "key={{ token }}").length).toBe(0)
    expect(scanRule(c, `key=changeme${body(35, 12)}`).length).toBe(1)
    expect(scanRule(c, `key=${body(36, 6)}<x>${body(37, 6)}`).length).toBe(1)
    expect(scanRule(c, `key=${body(38, 8)}dummy${body(39, 8)}`).length).toBe(1)
  })

  it("stopwords need the allowStopwords opt-in and never apply to provider rules", () => {
    const noOpt = compileRedactRule({ ...kv, allow: ["stopwords"] })
    expect(typeof noOpt === "string" && noOpt.includes("allowStopwords")).toBe(true)
    const opt = compile({ ...kv, allow: ["stopwords"], allowStopwords: true })
    expect(scanRule(opt, "key=mypassword123").length).toBe(0)
    const p = selfTest({ ...provider, allow: ["stopwords"], allowStopwords: true })
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.reason).toContain("allowStopwords")
  })
})
