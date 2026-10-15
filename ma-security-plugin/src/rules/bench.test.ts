// fix3 MAJOR 2c: CI bench gate. Every real redact rule alone on a 1 MB mixed corpus
// plus its own hostile text must stay at or under 50 ms/MB (SPEC-v3 Performance).
// fix4: one hostile text per variable char set (hostileTexts), strict 50 ms/MB, and a
// guard so the gate cannot pass with zero rules while rule files exist on disk.

import { readdirSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it, test } from "bun:test"

import { gen } from "./gen.ts"
import { REDACT_RULES } from "./index.ts"
import { loadRegistry } from "./registry.ts"
import { BENCH_MS_PER_MB, compileRedactRule, hostileTexts, scanRule } from "./selftest.ts"
import type { RedactRule } from "./types.ts"

const MB = 1_000_000

/** Deterministic mixed corpus: prose, code, JSON, base64-ish runs, long runs. */
function corpus(n: number): string {
  const chunks = [
    "The quick brown fox jumps over the lazy dog. ",
    'const config = { "api": "https://example.invalid/v1", "retries": 3 };\n',
    "export PATH=/usr/local/bin:$PATH && echo done\n",
    "Authorization header omitted; see docs for the token flow.\n",
    `${"a".repeat(300)}\n`,
    `${"=".repeat(200)}\n`,
    `${"/".repeat(200)} ${" ".repeat(200)}\n`,
    `${gen({ len: 400, charset: "b64url", seed: 7 })}\n`,
    `${gen({ len: 300, charset: "hex", seed: 8 })}\n`,
    "user@example.invalid 4111 1111 1111 1110 key=value; secret=\n",
  ]
  let s = ""
  for (let i = 0; s.length < n; i++) s += chunks[i % chunks.length]
  return s.slice(0, n)
}

function best(fn: () => void, runs: number): number {
  let b = Number.POSITIVE_INFINITY
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now()
    fn()
    b = Math.min(b, performance.now() - t0)
  }
  return b
}

/** Redact rule files on disk (secret/ and pii/), read without a process spawn. */
function redactFilesOnDisk(): number {
  let n = 0
  for (const dir of ["secret", "pii"]) {
    try {
      n += readdirSync(join(import.meta.dir, dir)).filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
      ).length
    } catch {
      // No folder: no files.
    }
  }
  return n
}

const PATTERN_RULES = REDACT_RULES.filter((r) => r.pattern !== undefined)

describe("fix3 CI bench gate (1 MB per rule)", () => {
  const text = corpus(MB)
  it("the corpus is 1 MB", () => {
    expect(text.length).toBe(MB)
  })
  // fix4 MAJOR 2: never pass vacuously. Files on disk with nothing benched is a failure.
  it("benches at least one rule when rule files exist on disk", () => {
    const files = redactFilesOnDisk()
    if (files > 0) expect(PATTERN_RULES.length).toBeGreaterThan(0)
  })
  if (PATTERN_RULES.length === 0)
    test.skip("REDACT_RULES has no pattern rules: nothing to bench (index not wired yet)", () => {})
  for (const rule of PATTERN_RULES) {
    it(`${rule.id} stays at or under ${BENCH_MS_PER_MB} ms/MB`, () => {
      const c = compileRedactRule(rule)
      if (typeof c === "string") throw new Error(c)
      scanRule(c, "warm up", { raw: true })
      const mixed = best(() => scanRule(c, text, { raw: true }), 3)
      expect(mixed).toBeLessThanOrEqual(BENCH_MS_PER_MB)
      for (const hostile of hostileTexts(rule, MB)) {
        const h = best(() => scanRule(c, hostile, { raw: true }), 3)
        expect(h).toBeLessThanOrEqual(BENCH_MS_PER_MB)
      }
    }, 30000)
  }
})

/** 30 synthetic, realistic rules: prefix plus one bounded class, varied gates. */
function syntheticRules(): RedactRule[] {
  const out: RedactRule[] = []
  for (let i = 0; i < 30; i++) {
    const p = `zq${String.fromCharCode(97 + (i % 26))}${i}-`
    const len = 20 + (i % 5) * 4
    out.push({
      id: `secret.bench.r${String(i).padStart(2, "0")}`,
      family: "secret",
      kind: `bench.r${i}`,
      severity: "high",
      gate: "keyword",
      keywords: [p],
      pattern: `\\b${p}[A-Za-z0-9_-]{${len}}(?=['"\\s;,]|$)`,
      explain: "Synthetic bench rule.",
      render: { publicPrefix: p },
      defaults: { status: "on", level: "mid" },
      examples: {
        match: [
          { text: `key: {{S}} ;`, secret: { prefix: p, len, charset: "alnum", seed: i + 1 } },
          { text: `x="{{S}}"`, secret: { prefix: p, len, charset: "alnum", seed: i + 101 } },
        ],
        not_match: [
          "nothing here",
          { text: `key: {{S}} ;`, secret: { prefix: p, len: len - 1, charset: "alnum", seed: 9 } },
        ],
      },
    })
  }
  return out
}

describe("fix3 load time", () => {
  it("30 synthetic rules load cold in under 150 ms with the bench gate on", () => {
    const rules = syntheticRules()
    const t0 = performance.now()
    const r = loadRegistry({ sources: { redact: rules } })
    const cold = performance.now() - t0
    const t1 = performance.now()
    loadRegistry({ sources: { redact: rules } })
    const warm = performance.now() - t1
    expect(r.disabled).toEqual([])
    expect(r.redact.length).toBe(30)
    // Reported numbers (fix3 report). The gate is the 150 ms cold target.
    expect({ cold: cold < 150, warm: warm < 150, coldMs: Math.round(cold) }).toMatchObject({
      cold: true,
      warm: true,
    })
  })
})
