// B4 fix round: marker shield bypass (D16 class), indented and legacy PEM, minors, and
// the foundation change (built-ins never wall-clock benched at load). gen() values only.
import { describe, expect, it } from "bun:test"

import { markerSamples } from "../redact/markers.ts"

import { gen } from "./gen.ts"
import { REDACT_RULES } from "./index.ts"
import { DISABLED_REASONS, loadRegistry } from "./registry.ts"
import { benchRule, type CompiledRedactRule, compileRedactRule, scanRule } from "./selftest.ts"
import type { RedactRule } from "./types.ts"

const compiled = new Map<string, CompiledRedactRule>(
  REDACT_RULES.map((r) => {
    const c = compileRedactRule(r)
    if (typeof c === "string") throw new Error(`${r.id}: ${c}`)
    return [r.id, c]
  }),
)
const hits = (id: string, text: string, raw = false): string[] =>
  scanRule(compiled.get(id) as CompiledRedactRule, text, { raw }).map((h) => h.value)

const tok = gen({ len: 40, charset: "alnum-_", seed: 77, suffix: "9" })
const sec = gen({ len: 32, charset: "alnum", seed: 78, suffix: "_1" })

describe("BLOCKER: a [REDACTED: prefix does not shield a real secret", () => {
  const cases: [string, string, string][] = [
    ["secret.generic.kv", `[REDACTED:x:token:${sec}`, sec],
    ["secret.generic.kv", `[REDACTED:secret:${sec}`, sec],
    ["secret.generic.kv", `[REDACTED:a.b api_key=${sec}`, sec],
    ["secret.generic.kv", `[REDACTED:api_key=${sec}`, sec],
    ["secret.http.auth-header", `[REDACTED:x Authorization: Bearer ${tok}`, tok],
    ["secret.http.auth-header", `[REDACTED:x.api-key:${tok}`, tok],
  ]
  for (const [id, text, want] of cases)
    it(`${id} hits ${text.slice(0, 24)}`, () => {
      expect(hits(id, text)).toEqual([want])
    })

  it("every marker sample of every kind gives zero hits on every rule (raw scan)", () => {
    const bad: string[] = []
    for (const r of REDACT_RULES)
      for (const s of markerSamples(r.kind))
        for (const id of compiled.keys())
          if (hits(id, s, true).length > 0) bad.push(`${id} on ${s}`)
    expect(bad).toEqual([])
  })

  it("a marker after a key name gives zero hits", () => {
    for (const r of REDACT_RULES)
      for (const s of markerSamples(r.kind))
        for (const head of ["api_key=", "token: ", "Authorization: Bearer ", "x-api-key: "]) {
          expect(hits("secret.generic.kv", head + s, true)).toEqual([])
          expect(hits("secret.http.auth-header", head + s, true)).toEqual([])
        }
  })
})

describe("secret.pem", () => {
  const body = Array.from({ length: 10 }, (_, i) =>
    gen({ len: 64, charset: "alnum", seed: 100 + i }),
  )
  it("M1: hits an indented PEM in a YAML block", () => {
    const pem = [
      "  -----BEGIN PRIVATE KEY-----",
      ...body.map((l) => `  ${l}`),
      "  -----END PRIVATE KEY-----",
    ].join("\n")
    const h = hits("secret.pem", `tls:\n  key: |\n${pem}\n`)
    expect(h).toEqual([pem.trimStart()])
  })
  it("M2: hits a legacy encrypted PEM (Proc-Type and DEK-Info headers)", () => {
    const iv = gen({ len: 32, charset: "hex", seed: 11 }).toUpperCase()
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "Proc-Type: 4,ENCRYPTED",
      `DEK-Info: AES-128-CBC,${iv}`,
      "",
      ...body,
      "-----END RSA PRIVATE KEY-----",
    ].join("\n")
    expect(hits("secret.pem", pem)).toEqual([pem])
  })
})

describe("minors", () => {
  it("m1: a 54-char LLM_ identifier with no digit gives no hit", () => {
    const ident = "LLM_ProviderAnthropicClaudeOpusFiveContextWindowLimitX"
    expect(ident.length).toBe(54)
    expect(hits("secret.meta.api-key", ident)).toEqual([])
  })
  it("m1: a 64-char body with a digit hits", () => {
    const k = gen({ prefix: "LLM_", len: 63, charset: "alnum", seed: 9, suffix: "7" })
    expect(hits("secret.meta.api-key", `META=${k}`)).toEqual([k])
  })
  it("m2: openai.prefix catches sk-None-", () => {
    const k = gen({ prefix: "sk-None-", len: 48, charset: "alnum-_", seed: 4 })
    expect(hits("secret.openai.prefix", `OPENAI_API_KEY=${k}`)).toEqual([k])
  })
  it("m3: kv does not hit auth=createAuthHandler_v2", () => {
    expect(hits("secret.generic.kv", "auth=createAuthHandler_v2")).toEqual([])
    expect(hits("secret.generic.kv", "const x = { auth=createAuthHandler_v2 }")).toEqual([])
  })
  it("m3: kv still hits a short value with two digits and a long value", () => {
    const short = gen({ len: 14, charset: "alnum", seed: 31, suffix: "4_2" })
    expect(hits("secret.generic.kv", `DB_PASSWORD=${short}`)).toEqual([short])
    const long = gen({ len: 24, charset: "alnum", seed: 32, suffix: "_" })
    expect(hits("secret.generic.kv", `token: "${long}"`)).toEqual([long])
  })
  it("Marcos: anthropic.prefix catches an unknown kind sk-ant-xyz02-", () => {
    const k = gen({ prefix: "sk-ant-xyz02-", len: 80, charset: "alnum-_", seed: 5 })
    expect(hits("secret.anthropic.prefix", `KEY=${k}`)).toEqual([k])
  })
})

describe("F: built-ins are never wall-clock benched at load", () => {
  const bomb = Object.assign(
    {
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
    } satisfies RedactRule,
    // A forged flag on the rule object. It must never skip the bench.
    { builtin: true },
  ) as RedactRule

  it("a custom rule with builtin: true is still benched and disabled", () => {
    const r = loadRegistry({ custom: { redact: [bomb] } })
    expect(r.disabled).toEqual([{ id: "secret.test.bomb", reason: "bench", builtin: false }])
    expect(r.redact.length).toBe(REDACT_RULES.length)
  })

  it("a built-in is never benched at load; a custom rule is", () => {
    let n = 0
    const benchImpl: typeof benchRule = (c, ...rest) => {
      n++
      return benchRule(c, ...rest)
    }
    const r = loadRegistry({ benchImpl })
    expect(n).toBe(0)
    expect(r.disabled).toEqual([])
    const custom = { ...(REDACT_RULES.find((x) => x.id === "secret.xai.api-key") as RedactRule) }
    custom.id = "secret.custom.xai-copy"
    const r2 = loadRegistry({ benchImpl, custom: { redact: [custom] } })
    expect(n).toBe(1)
    expect(r2.redact.some((c) => c.rule.id === "secret.custom.xai-copy")).toBe(true)
  })

  it("a failing bench never disables a built-in", () => {
    const benchImpl: typeof benchRule = () => ({ ok: false, reason: "bench: forced", msPerMb: 1e9 })
    const r = loadRegistry({ benchImpl })
    expect(r.disabled).toEqual([])
    expect(r.redact.length).toBe(REDACT_RULES.length)
  })

  it("a custom rule that reuses a built-in id is disabled alone", () => {
    const dup = { ...(REDACT_RULES.find((x) => x.id === "secret.xai.api-key") as RedactRule) }
    const r = loadRegistry({ custom: { redact: [dup] } })
    expect(r.disabled).toEqual([
      { id: "secret.xai.api-key", reason: "duplicate-id", builtin: false },
    ])
    expect(r.redact.length).toBe(REDACT_RULES.length)
    expect(r.redact.find((c) => c.rule.id === "secret.xai.api-key")?.rule).toBe(
      REDACT_RULES.find((x) => x.id === "secret.xai.api-key") as RedactRule,
    )
  })

  it("disabled entries are {id, reason, builtin} with a fixed reason", () => {
    const r = loadRegistry({ sources: { redact: [bomb, bomb] }, custom: { redact: [bomb] } })
    expect(r.disabled.length).toBeGreaterThan(0)
    for (const d of r.disabled) {
      expect(Object.keys(d).sort()).toEqual(["builtin", "id", "reason"])
      expect(DISABLED_REASONS).toContain(d.reason)
      expect(typeof d.builtin).toBe("boolean")
    }
  })
})
