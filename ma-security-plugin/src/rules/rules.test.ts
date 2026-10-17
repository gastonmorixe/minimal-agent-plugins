// B4: the first 30 redact rules. Registry load, per-rule self-test, marker safety,
// 1 MB bench per rule (SPEC CI gate 50 ms/MB), and worst-case input per rule.
import { describe, expect, it } from "bun:test"

import { CHARSETS, gen } from "./gen.ts"
import { REDACT_RULES } from "./index.ts"
import { loadRegistry } from "./registry.ts"
import {
  BENCH_MS_PER_MB,
  type CompiledRedactRule,
  compileRedactRule,
  hostileTexts,
  markerSafety,
  scanRule,
  selfTest,
} from "./selftest.ts"
import type { RedactRule } from "./types.ts"

const MB = 1 << 20

/** SPEC order. The index is sorted by id, so this list checks the scope separately. */
const SPEC_30 = [
  "secret.known-value.harness",
  "secret.anthropic.oauth-access",
  "secret.anthropic.oauth-refresh",
  "secret.generic.jwt",
  "secret.openai.svcacct",
  "secret.openrouter.api-key",
  "secret.wafer.api-key",
  "secret.meta.api-key",
  "secret.opencode.api-key",
  "secret.huggingface.token",
  "pii.harness-identity",
  "secret.pem",
  "secret.http.auth-header",
  "secret.generic.url-cred",
  "pii.email",
  "secret.generic.kv",
  "secret.anthropic.api-key",
  "secret.anthropic.admin-key",
  "secret.anthropic.prefix",
  "secret.openai.api-key",
  "secret.openai.prefix",
  "secret.xai.api-key",
  "secret.aws.access-key-id",
  "secret.github.token",
  "secret.github.fine-grained-pat",
  "secret.gitlab.pat",
  "secret.slack.token",
  "secret.stripe.key",
  "secret.google.api-key",
  "pii.card",
]

function compiled(rule: RedactRule): CompiledRedactRule {
  const c = compileRedactRule(rule)
  if (typeof c === "string") throw new Error(`${rule.id}: ${c}`)
  return c
}

const PATTERN_RULES = REDACT_RULES.filter((r) => r.pattern !== undefined)

/** Best of 5 after 1 warmup, in ms per MB. Raw scan: regex cost only. */
export function msPerMb(c: CompiledRedactRule, text: string): number {
  scanRule(c, text, { raw: true })
  let best = Number.POSITIVE_INFINITY
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now()
    scanRule(c, text, { raw: true })
    best = Math.min(best, performance.now() - t0)
  }
  return (best * MB) / text.length
}

/**
 * J section 4 corpus for one rule: its keywords, each followed by a long charset run,
 * near misses one char short, and a missing end delimiter. Plus the shared hostile set.
 */
export function ruleCorpus(rule: RedactRule, size = MB): string {
  const keys = rule.keywords.length > 0 ? rule.keywords : ["@", "4111 ", "://"]
  const parts: string[] = []
  let n = 0
  let seed = 7
  const push = (s: string): void => {
    parts.push(s)
    n += s.length
  }
  const hostile = [
    "a".repeat(4096),
    "=".repeat(4096),
    "/".repeat(4096),
    " ".repeat(4096),
    "'\"`".repeat(1365),
    "1234 ".repeat(800),
    "a.".repeat(2048),
    "-".repeat(4096),
  ]
  for (const h of hostile) push(`${h}\n`)
  while (n < size) {
    for (const k of keys) {
      for (const charset of Object.keys(CHARSETS) as (keyof typeof CHARSETS)[]) {
        seed++
        push(`${k}${gen({ len: 300, charset, seed })}#`)
        push(` x=${k}${gen({ len: 31, charset, seed: seed + 1 })} `)
        push(`"${k}${gen({ len: 64, charset, seed: seed + 2 })}`)
      }
    }
  }
  return parts.join("").slice(0, size)
}

describe("B4 first 30 rules", () => {
  it("index holds exactly the SPEC 30 ids", () => {
    expect(REDACT_RULES.map((r) => r.id).sort()).toEqual([...SPEC_30].sort())
  })

  it("registry loads with nothing disabled and no errors", () => {
    const r = loadRegistry()
    expect(r.disabled).toEqual([])
    expect(r.errors).toEqual([])
    expect(r.redact.length).toBe(30)
  })

  for (const rule of REDACT_RULES) {
    it(`self-test passes: ${rule.id}`, () => {
      expect(selfTest(rule)).toEqual({ id: rule.id, ok: true })
    })
  }

  it("marker safety passes across all 30", () => {
    expect(markerSafety(REDACT_RULES.map(compiled))).toEqual([])
  })

  it("known-value only rules have no pattern and a knownValue key list", () => {
    for (const id of ["secret.known-value.harness", "pii.harness-identity"]) {
      const r = REDACT_RULES.find((x) => x.id === id) as RedactRule
      expect(r.pattern).toBeUndefined()
      expect(r.knownValue?.keys.length).toBeGreaterThan(0)
    }
  })

  it("flags are empty or i, explain is 120 chars or less", () => {
    for (const r of REDACT_RULES) {
      expect(["", "i", undefined]).toContain(r.flags)
      expect(r.explain.length).toBeLessThanOrEqual(120)
    }
  })

  it("SPEC levels: pii.email and pii.harness-identity low, all others mid", () => {
    for (const r of REDACT_RULES) {
      const low = r.id === "pii.email" || r.id === "pii.harness-identity"
      expect(r.defaults.level).toBe(low ? "low" : "mid")
    }
  })

  it("adjacent tokens both match (end-of-token lookahead)", () => {
    const pairs: [string, string][] = [
      ["secret.github.token", "ghp_"],
      ["secret.openrouter.api-key", "sk-or-v1-"],
      ["secret.huggingface.token", "hf_"],
    ]
    for (const [id, prefix] of pairs) {
      const r = REDACT_RULES.find((x) => x.id === id) as RedactRule
      const a = gen({ prefix, len: 36, charset: "alnum", seed: 11 })
      const b = gen({ prefix, len: 36, charset: "alnum", seed: 12 })
      expect(scanRule(compiled(r), `${a} ${b}`).map((h) => h.value)).toEqual([a, b])
    }
  })
})

describe("B4 bench gate (1 MB per rule, 50 ms/MB)", () => {
  for (const rule of PATTERN_RULES) {
    it(`bench: ${rule.id}`, () => {
      const c = compiled(rule)
      const ms = msPerMb(c, ruleCorpus(rule))
      expect(ms).toBeLessThanOrEqual(BENCH_MS_PER_MB)
    })
  }
})

describe("B4 adversarial input (worst case per rule)", () => {
  for (const rule of PATTERN_RULES) {
    it(`adversarial: ${rule.id}`, () => {
      const c = compiled(rule)
      for (const text of hostileTexts(rule, 256 * 1024)) {
        expect(msPerMb(c, text)).toBeLessThanOrEqual(BENCH_MS_PER_MB)
      }
    })
  }
})
