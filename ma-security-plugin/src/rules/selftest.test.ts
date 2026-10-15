import { describe, expect, it } from "bun:test"

import { gen } from "./gen.ts"
import { REDACT_RULES } from "./index.ts"
import { loadRegistry } from "./registry.ts"
import {
  compileRedactRule,
  markerSafety,
  scanRule,
  selfTest,
  staticShapeCheck,
} from "./selftest.ts"
import type { CmdRule, Gen, PathRule, RedactRule } from "./types.ts"

// Synthetic rules only. The prefix "zzq-tok-" is not a real provider format.
const S = (seed: number, len = 20): Gen => ({ prefix: "zzq-tok-", len, charset: "alnum", seed })

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
    match: [
      { text: "key: {{S}}", secret: S(1) },
      { text: 'x="{{S}}";', secret: S(2) },
    ],
    not_match: [
      "no token here",
      { text: "key: {{S}}", secret: S(3, 19) },
      { text: "{{S}}x", secret: S(4) },
    ],
  },
}

const nested: RedactRule = { ...good, id: "secret.test.nested", pattern: "zzq-tok-(?:[a-z]+)+" }

const badExample: RedactRule = {
  ...good,
  id: "secret.test.bad-example",
  examples: { match: [{ text: "key: {{S}}", secret: S(5, 12) }], not_match: [] },
}

const noCompile: RedactRule = { ...good, id: "secret.test.no-compile", pattern: "zzq-tok-[" }

const card: RedactRule = {
  id: "pii.test.card",
  family: "pii",
  kind: "card",
  severity: "medium",
  gate: "digit-run",
  keywords: [],
  pattern: "\\b\\d{16}\\b",
  explain: "Synthetic card test.",
  validator: "luhn",
  render: {},
  defaults: { status: "on", level: "mid" },
  examples: { match: ["card 4242424242424242 ok"], not_match: ["card 4242424242424241 ok"] },
  notes: "digit-run gate: cards have no keyword",
}

describe("selfTest", () => {
  it("passes a good rule", () => {
    expect(selfTest(good)).toEqual({ id: good.id, ok: true })
  })

  it("passes a validator rule with a near miss", () => {
    expect(selfTest(card)).toEqual({ id: card.id, ok: true })
  })

  it("fails nested quantifiers, bad examples, and bad patterns without throwing", () => {
    const n = selfTest(nested)
    expect(n.ok).toBe(false)
    if (!n.ok) expect(n.reason).toContain("nested quantifier")
    const b = selfTest(badExample)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.reason).toContain("match[0]")
    const c = selfTest(noCompile)
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.reason).toContain("compile")
  })

  it("fails a keyword gate with short keywords and a long explain", () => {
    const r = selfTest({ ...good, keywords: ["zz"], explain: "x".repeat(121) })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("3+ chars")
      expect(r.reason).toContain("explain")
    }
  })

  it("fails the prefilter invariant and a wrong public prefix", () => {
    const r = selfTest({ ...good, keywords: ["nothere"], render: { publicPrefix: "zzq-x" } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("prefilter invariant")
      expect(r.reason).toContain("publicPrefix")
    }
  })

  it("never throws on garbage input", () => {
    const r = selfTest(null as unknown as RedactRule)
    expect(r.ok).toBe(false)
  })

  it("runs path and cmd hooks", () => {
    const p: PathRule = {
      id: "path.test.p",
      family: "path",
      severity: "high",
      explain: "p",
      globs: ["**/x"],
      decision: { read: "deny", write: "deny" },
      defaults: { status: "on" },
      examples: { match: ["/a/x"], not_match: ["/a/y"] },
    }
    expect(selfTest(p, { pathMatcher: (_r, path) => path.endsWith("/x") }).ok).toBe(true)
    expect(selfTest(p, { pathMatcher: () => true }).ok).toBe(false)
    const c: CmdRule = {
      id: "cmd.test.c",
      family: "cmd",
      severity: "high",
      explain: "c",
      decision: "deny",
      match: (cmd) => cmd.basename === "zap",
      keywords: ["zap"],
      defaults: { status: "on" },
      examples: { match: ["zap"], not_match: ["ls"] },
    }
    const ev = (r: CmdRule, line: string) => (line === "zap" ? r.decision : null)
    expect(selfTest(c, { cmdEvaluator: ev }).ok).toBe(true)
  })
})

describe("scanRule and static check", () => {
  it("finds two adjacent tokens", () => {
    const c = compileRedactRule(good)
    if (typeof c === "string") throw new Error(c)
    const a = gen(S(7))
    const b = gen(S(8))
    expect(scanRule(c, `${a} ${b}`).map((h) => h.value)).toEqual([a, b])
  })

  it("flags lazy prefix and unbounded repeats unless reviewed", () => {
    expect(staticShapeCheck("[\\w.-]{0,50}?key")).toContain("leading lazy prefix")
    expect(staticShapeCheck("key.*end")).toContain("unbounded quantifier")
    expect(staticShapeCheck("key.*end", "reviewed:unbounded")).toEqual([])
    expect(staticShapeCheck("key\\.{1,3}end")).toEqual([])
  })
})

describe("M1 static shape check (tokenizer)", () => {
  const cases: [string, string][] = [
    ["(a|aa)+b", "nested quantifier"],
    ["((a+))+", "nested quantifier"],
    ["(a{1,9}){1,9}", "nested quantifier"],
    ["x.{0,}y", "unbounded quantifier"],
    ["x[^]*y", "unbounded quantifier"],
    ["x[\\w\\W]+y", "unbounded quantifier"],
    ["\\b.{0,40}?key", "leading lazy prefix"],
    ["[a-z]+?key", "leading lazy prefix"],
    ["(?:[a-z]{0,5}?)key", "leading lazy prefix"],
  ]
  for (const [p, want] of cases) {
    it(`flags ${p}`, () => {
      expect(staticShapeCheck(p)).toContain(want)
    })
  }

  it("passes bounded shapes and ignores escapes and classes", () => {
    expect(staticShapeCheck("\\bzzq-tok-[A-Za-z0-9]{20}(?=\\\\?['\"`]|[\\s;]|\\\\[nr]|$)")).toEqual(
      [],
    )
    expect(staticShapeCheck("a\\*\\+[*+{]{1,4}b")).toEqual([])
    expect(staticShapeCheck("(?:-[0-9a-f]{4}){3}")).toEqual([])
    expect(staticShapeCheck("(?:ab|cd)?x")).toEqual([])
    expect(staticShapeCheck("key[a-z]{1,8}?x")).toEqual([])
  })

  it("keeps the reviewed opt-out per check", () => {
    expect(staticShapeCheck("(a{1,9}){1,9}", "reviewed:nested")).toEqual([])
    expect(staticShapeCheck("[a-z]{1,9}?key", "reviewed:lazy-prefix")).toEqual([])
  })
})

describe("minor fixes", () => {
  it("m1: group 0 compiles without the d flag", () => {
    const c = compileRedactRule(good)
    if (typeof c === "string") throw new Error(c)
    expect(c.re?.hasIndices).toBe(false)
    const g = compileRedactRule({ ...good, pattern: "key: (zzq-tok-[A-Za-z0-9]{20})", group: 1 })
    if (typeof g === "string") throw new Error(g)
    expect(g.re?.hasIndices).toBe(true)
    const v = gen(S(9))
    expect(scanRule(g, `key: ${v}`)).toEqual([{ start: 5, end: 5 + v.length, value: v }])
  })

  it("m3: compile rejects an unknown validator", () => {
    const r = compileRedactRule({ ...card, validator: "nope" as unknown as "luhn" })
    expect(typeof r === "string" && r.includes("unknown validator")).toBe(true)
  })

  it("m4: prefilter invariant uses the automaton fold and the 300 char window", () => {
    // U+212A (Kelvin) lowercases to "k" in Unicode but not in the ASCII fold.
    const r = selfTest({
      ...good,
      keywords: ["key"],
      examples: { match: [{ text: "\u212AEY {{S}}", secret: S(1) }], not_match: [] },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("prefilter invariant")
    const far = selfTest({
      ...good,
      keywords: ["far"],
      examples: { match: [{ text: `far ${"x ".repeat(200)}{{S}}`, secret: S(1) }], not_match: [] },
    })
    expect(far.ok).toBe(false)
    if (!far.ok) expect(far.reason).toContain("300")
  })

  it("m5: every keyword needs 3+ chars", () => {
    const r = selfTest({ ...good, keywords: ["zzq-tok-", "zz"] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("3+ chars")
  })

  it("m6: publicPrefix is checked on plain string examples", () => {
    const r = selfTest({
      ...card,
      render: { publicPrefix: "9999" },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("publicPrefix")
  })

  it("m7: a null or id-less rule does not disable the whole registry", () => {
    const r = loadRegistry({
      sources: { redact: [good, null as unknown as RedactRule, { ...good, id: 7 } as never] },
    })
    expect(r.redact.map((c) => c.rule.id)).toEqual(["secret.test.good"])
    expect(r.disabled.some((d) => d.id === "*")).toBe(false)
    expect(r.disabled.length).toBe(2)
  })

  it("m8: a duplicate id disables both copies", () => {
    const dup: RedactRule = { ...good, id: "secret.test.dup" }
    const r = loadRegistry({ sources: { redact: [dup, good, dup] } })
    expect(r.redact.map((c) => c.rule.id)).toEqual(["secret.test.good"])
    expect(r.disabled).toEqual([{ id: "secret.test.dup", reason: "duplicate id (2 rules)" }])
  })
})

describe("M2 marker safety across the full rule set", () => {
  // Rule B matches the low/mid marker of rule good: "zzq-tok-[REDACTED...".
  const catcher: RedactRule = {
    id: "secret.test.catcher",
    family: "secret",
    kind: "test.catcher",
    severity: "low",
    gate: "keyword",
    keywords: ["zzq-tok-"],
    pattern: "zzq-tok-\\[[A-Z]{8}",
    explain: "Synthetic rule that catches another rule's marker.",
    render: {},
    defaults: { status: "on", level: "mid" },
    examples: { match: ["see zzq-tok-[ABCDEFGH here"], not_match: ["zzq-tok-x"] },
  }

  it("each rule passes its own self-test", () => {
    expect(selfTest(good).ok).toBe(true)
    expect(selfTest(catcher).ok).toBe(true)
  })

  it("markerSafety names the rule that matches another rule's marker", () => {
    const cs = [good, catcher].map((r) => {
      const c = compileRedactRule(r)
      if (typeof c === "string") throw new Error(c)
      return c
    })
    const off = markerSafety(cs)
    expect(off.map((d) => d.id)).toEqual(["secret.test.catcher"])
    expect(off[0]?.reason).toContain("marker of secret.test.good")
  })

  it("the registry disables the offender and keeps the other rule", () => {
    const r = loadRegistry({ sources: { redact: [good, catcher] } })
    expect(r.redact.map((c) => c.rule.id)).toEqual(["secret.test.good"])
    expect(r.disabled.map((d) => d.id)).toEqual(["secret.test.catcher"])
    expect(r.automaton.keywords).toEqual(["zzq-tok-"])
    expect(r.keywordRules).toEqual([[0]])
  })
})

describe("review2 MJ1 marker safety only flags hits on a marker", () => {
  const compile = (r: RedactRule) => {
    const c = compileRedactRule(r)
    if (typeof c === "string") throw new Error(c)
    return c
  }
  // Token rule whose example holds a plain email as context (not a marker).
  const tok: RedactRule = {
    ...good,
    id: "secret.a.tok",
    examples: {
      match: [{ text: "mail bob@site.org key {{S}} ;", secret: S(11) }],
      not_match: ["no token here"],
    },
  }
  const email: RedactRule = {
    id: "pii.test.email",
    family: "pii",
    kind: "email",
    severity: "medium",
    gate: "always",
    keywords: [],
    pattern: "\\b[a-z]{1,20}@site\\.org\\b",
    explain: "Synthetic email rule.",
    render: {},
    defaults: { status: "on", level: "mid" },
    examples: { match: ["write bob@site.org now"], not_match: ["write bob@other.org now"] },
    notes: "always gate: an email has no keyword",
  }
  const catcher: RedactRule = {
    ...good,
    id: "secret.test.catcher",
    kind: "test.catcher",
    pattern: "zzq-tok-\\[[A-Z]{8}",
    render: {},
    examples: { match: ["see zzq-tok-[ABCDEFGH here"], not_match: ["zzq-tok-x"] },
  }

  it("each rule passes its own self-test", () => {
    expect(selfTest(tok)).toEqual({ id: tok.id, ok: true })
    expect(selfTest(email)).toEqual({ id: email.id, ok: true })
    expect(selfTest(catcher)).toEqual({ id: catcher.id, ok: true })
  })

  it("an email in example context does not flag the email rule", () => {
    expect(markerSafety([tok, email].map(compile))).toEqual([])
    const r = loadRegistry({ sources: { redact: [tok, email] } })
    expect(r.redact.map((c) => c.rule.id)).toEqual(["pii.test.email", "secret.a.tok"])
    expect(r.disabled).toEqual([])
  })

  it("a real marker catcher is still disabled", () => {
    const r = loadRegistry({ sources: { redact: [tok, email, catcher] } })
    expect(r.redact.map((c) => c.rule.id)).toEqual(["pii.test.email", "secret.a.tok"])
    expect(r.disabled.map((d) => d.id)).toEqual(["secret.test.catcher"])
  })
})

describe("review2 mn1 lookaround is an assertion for the lazy check", () => {
  it("flags a lazy first atom after a lookaround", () => {
    expect(staticShapeCheck("(?<!x)[a-z]{1,9}?k")).toContain("leading lazy prefix")
    expect(staticShapeCheck("(?=x)[a-z]{0,9}?k")).toContain("leading lazy prefix")
    expect(staticShapeCheck("(?<=x)(?!y)[a-z]{0,9}?k")).toContain("leading lazy prefix")
  })

  it("still checks lookaround bodies", () => {
    expect(staticShapeCheck("(?=a+)b")).toContain("unbounded quantifier")
    expect(staticShapeCheck("(?<!x)k[a-z]{1,9}?")).toEqual([])
  })
})

describe("review2 mn2 huge bound", () => {
  it("flags a max over 1024 unless reviewed", () => {
    expect(staticShapeCheck("x.{0,100000}y")).toContain("huge bound")
    expect(staticShapeCheck("x[^]{0,99999}y")).toContain("huge bound")
    expect(staticShapeCheck("x[a-z]{2000}y")).toContain("huge bound")
    expect(staticShapeCheck("x.{0,1024}y")).toEqual([])
    expect(staticShapeCheck("x.{0,100000}y", "reviewed:huge-bound")).toEqual([])
  })
})

describe("review2 mn3 fewer nested false positives", () => {
  for (const p of [
    "(?:-[a-z0-9]{4,8}){3}",
    "(?:ab|cd){1,9}",
    "(?:[A-Za-z0-9]|-){20,40}",
    "(?:x|yy){2,4}z",
    "(?:\\.[a-z]{2,6}){1,3}",
    "(?:[a-z]|[0-9]){1,9}",
  ]) {
    it(`passes ${p}`, () => {
      expect(staticShapeCheck(p)).toEqual([])
    })
  }
  for (const p of [
    "(a|aa)+b",
    "((a+))+",
    "(a{1,9}){1,9}",
    "(?:a|a){1,9}",
    "(?:[a-z]|a){1,9}",
    "(?:[a-z]|A){1,9}",
    "(?:ab|ac){1,9}",
    "(?:a[a-z]{1,4}){1,5}",
    "(?:-[a-z-]{1,4}){1,5}",
    "(?:-[a-z]{1,4}x{0,2}){1,5}",
  ]) {
    it(`still flags ${p}`, () => {
      expect(staticShapeCheck(p)).toContain("nested quantifier")
    })
  }
})

describe("review2 mn4 marker safety internal error", () => {
  it("keeps the compiled set and records the error (returned entry)", () => {
    const r = loadRegistry({
      sources: { redact: [good] },
      markerSafetyImpl: () => [{ id: "*", reason: "marker safety internal: boom" }],
    })
    expect(r.redact.map((c) => c.rule.id)).toEqual(["secret.test.good"])
    expect(r.disabled).toEqual([])
    expect(r.errors).toEqual(["marker safety internal: boom"])
  })

  it("keeps the compiled set when the check throws", () => {
    const r = loadRegistry({
      sources: { redact: [good] },
      markerSafetyImpl: () => {
        throw new Error("boom")
      },
    })
    expect(r.redact.map((c) => c.rule.id)).toEqual(["secret.test.good"])
    expect(r.disabled).toEqual([])
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]).toContain("boom")
  })

  it("a clean load has no errors", () => {
    expect(loadRegistry({ sources: { redact: [good] } }).errors).toEqual([])
  })
})

describe("loadRegistry", () => {
  it("mn5: the real REDACT_RULES load with nothing disabled", () => {
    const r = loadRegistry()
    expect(r.disabled).toEqual([])
    expect(r.errors).toEqual([])
    expect(r.redact.map((c) => c.rule.id)).toEqual(REDACT_RULES.map((x) => x.id).sort())
  })

  it("disables failing rules with a reason and keeps good ones", () => {
    const r = loadRegistry({
      sources: {
        redact: [nested, good, noCompile, good],
        aliases: { "secret.test.old": "secret.test.good" },
      },
    })
    expect(r.redact.map((c) => c.rule.id)).toEqual([])
    expect(r.disabled.map((d) => d.id).sort()).toEqual([
      "secret.test.good",
      "secret.test.nested",
      "secret.test.no-compile",
    ])
    expect(r.disabled.find((d) => d.id === "secret.test.good")?.reason).toBe(
      "duplicate id (2 rules)",
    )
    const ok = loadRegistry({ sources: { redact: [nested, good] } })
    expect(ok.automaton.keywords).toEqual(["zzq-tok-"])
    expect(ok.keywordRules).toEqual([[0]])
    expect(r.resolveId("secret.test.old")).toEqual({ id: "secret.test.good", aliased: true })
    expect(r.resolveId("secret.test.good")).toEqual({ id: "secret.test.good", aliased: false })
  })
})
