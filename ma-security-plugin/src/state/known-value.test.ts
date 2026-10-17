import { describe, expect, it } from "bun:test"

import { isRandomLooking } from "../engine/random.ts"
import { LEVELS_ON, markerSamples, renderMarker } from "../redact/markers.ts"
import { gen } from "../rules/gen.ts"

import * as KV from "./known-value.ts"
import {
  createKnownValueIndex,
  DEFAULT_MAX_DERIVED,
  encodingsOf,
  KnownValueLoadError,
} from "./known-value.ts"
import { memorySessionKey } from "./session-key.ts"
import type { KnownValueMeta, SessionKey } from "./types.ts"
import { DEFAULT_VAULT_MAX_ENTRIES } from "./vault.ts"

const H: KnownValueMeta = {
  ruleId: "secret.known-value.harness",
  kind: "credential",
  source: "harness",
}
const V: KnownValueMeta = { ruleId: "vault.derived", kind: "secret", source: "vault" }
const E: KnownValueMeta = { ruleId: "secret.known-value.env", kind: "env-secret", source: "env" }
const I: KnownValueMeta = {
  ruleId: "pii.harness-identity",
  kind: "identity",
  source: "harness",
  class: "identity",
}

function fresh(opts: { maxDerived?: number | null } = {}) {
  return createKnownValueIndex({ key: memorySessionKey(), ...opts })
}

const tok = gen({ prefix: "tst_", len: 40, charset: "alnum", seed: 77 })

describe("add and lookup", () => {
  it("ignores values under min_len 8", () => {
    const ix = fresh()
    expect(ix.add("short12", H)).toBe(false)
    expect(ix.add("eightch8", H)).toBe(true)
    expect(ix.size).toBe(1)
    expect(ix.find("x short12 y")).toEqual([])
  })

  it("a configured min_len above 8 is used, below 8 is floored", () => {
    const k = memorySessionKey()
    expect(createKnownValueIndex({ key: k, minLen: 12 }).add("elevenchars", H)).toBe(false)
    expect(createKnownValueIndex({ key: k, minLen: 2 }).add("seven77", H)).toBe(false)
  })

  it("lookupValue and lookupTag share the key tag", () => {
    const k = memorySessionKey()
    const ix = createKnownValueIndex({ key: k })
    ix.add(tok, H)
    const e = ix.lookupValue(tok)
    expect(e?.tag).toBe(k.tag(tok) as string)
    expect(ix.lookupTag(k.tag(tok) as string)?.value).toBe(tok)
    expect(ix.sources()).toEqual({ harness: 1, env: 0, vault: 0 })
  })

  it("encodingsOf gives 4 forms", () => {
    const v = "a+b/c?d=e&f g"
    const enc = encodingsOf(v)
    expect(enc.raw).toBe(v)
    expect(enc.base64).toBe(Buffer.from(v).toString("base64"))
    expect(enc.base64url).toBe(Buffer.from(v).toString("base64url"))
    expect(enc.url).toBe(encodeURIComponent(v))
  })
})

describe("find: whole-token, 4 encodings", () => {
  const ix = fresh()
  ix.add(tok, H)
  const b64 = Buffer.from(tok).toString("base64")
  const b64u = Buffer.from(tok).toString("base64url")

  it("raw: KEY=v, quoted, v., URL query", () => {
    for (const text of [
      `KEY=${tok}`,
      `"${tok}"`,
      `'${tok}'`,
      `ends ${tok}.`,
      `https://x.test/a?k=${tok}&b=1`,
      tok,
    ]) {
      const hits = ix.find(text)
      expect(hits.length).toBe(1)
      const h = hits[0]
      expect(h?.encoding).toBe("raw")
      expect(text.slice(h?.start, h?.end)).toBe(tok)
      expect(h?.value).toBe(tok)
      expect(h?.layer).toBe("known-value")
      expect(h?.ruleId).toBe(H.ruleId)
      expect(h?.entry.value).toBe(tok)
    }
  })

  it("token mode: not inside a longer token, but `/` is a boundary for a form without `/`", () => {
    const idx = fresh()
    const id = gen({ len: 32, charset: "hex", seed: 78 })
    idx.add(id, I)
    expect(idx.find(`x${id}`)).toEqual([])
    expect(idx.find(`${id}_x`)).toEqual([])
    expect(idx.find(`${id}-y`)).toEqual([])
    expect(idx.find(`path/${id}`).length).toBe(1)
  })

  it("is case-sensitive", () => {
    expect(ix.find(tok.toUpperCase())).toEqual([])
  })

  it("base64 and base64url forms carry the raw tag", () => {
    const t1 = ix.find(`Authorization: Basic ${b64}`)
    expect(t1.map((h) => h.encoding)).toEqual(["base64"])
    expect(t1[0]?.tag).toBe(ix.lookupValue(tok)?.tag as string)
    expect(t1[0]?.value).toBe(b64)
    const t2 = ix.find(`jwt.${b64u}.sig`)
    expect(t2.length).toBe(1)
    expect(["base64", "base64url"]).toContain(t2[0]?.encoding as string)
  })

  it("url-encoded form", () => {
    const ix2 = fresh()
    const v = "pa ss@word!1"
    ix2.add(v, H)
    const enc = encodeURIComponent(v)
    const hits = ix2.find(`?p=${enc}&q=1`)
    expect(hits.map((h) => [h.encoding, h.value])).toEqual([["url", enc]])
  })

  it("many hits are sorted by start and do not overlap", () => {
    const ix3 = fresh()
    const a = gen({ prefix: "aa_", len: 20, charset: "alnum", seed: 1 })
    const b = gen({ prefix: "bb_", len: 20, charset: "alnum", seed: 2 })
    ix3.add(a, H)
    ix3.add(b, E)
    const text = `${b} and ${a} again ${b}`
    const hits = ix3.find(text)
    expect(hits.map((h) => h.value)).toEqual([b, a, b])
    expect(hits.map((h) => h.entry.source)).toEqual(["env", "harness", "env"])
    for (let i = 1; i < hits.length; i++) {
      expect((hits[i]?.start as number) >= (hits[i - 1]?.end as number)).toBe(true)
    }
  })

  it("leftmost-longest when one value is a prefix of another", () => {
    const ix4 = fresh()
    ix4.add("abcdefgh", H)
    ix4.add("abcdefgh.ijkl", H)
    const hits = ix4.find("see abcdefgh.ijkl now")
    expect(hits.map((h) => h.value)).toEqual(["abcdefgh.ijkl"])
    expect(ix4.find("see abcdefgh. now").map((h) => h.value)).toEqual(["abcdefgh"])
  })

  it("empty index and empty text", () => {
    expect(fresh().find("anything at all here")).toEqual([])
    expect(ix.find("")).toEqual([])
  })
})

describe("reload is add-only", () => {
  it("adds, never removes, and a failed load keeps the last good index", () => {
    const ix = fresh()
    const a = gen({ len: 30, charset: "alnum", seed: 10 })
    const b = gen({ len: 30, charset: "alnum", seed: 11 })
    expect(ix.reload("harness", () => [{ value: a, meta: H }])).toEqual({ added: 1 })
    expect(ix.lastLoadError).toBeNull()
    // Second load without `a`: `a` stays.
    expect(ix.reload("harness", () => [{ value: b, meta: H }])).toEqual({ added: 1 })
    expect(ix.lookupValue(a)).toBeDefined()
    // Failed load.
    const r = ix.reload("harness", () => {
      throw new KnownValueLoadError("parse failed")
    })
    expect(r).toEqual({ error: "parse failed" })
    expect(ix.lastLoadError).toBe("parse failed")
    expect(ix.size).toBe(2)
    expect(ix.find(`${a} ${b}`).length).toBe(2)
    // A clean load clears the error.
    ix.reload("harness", () => [])
    expect(ix.lastLoadError).toBeNull()
  })

  it("a foreign error never leaks its message (could hold a value)", () => {
    const ix = fresh()
    const r = ix.reload("harness", () => {
      throw new SyntaxError(`Unexpected token in ${tok}`)
    })
    expect(JSON.stringify(r)).not.toContain(tok)
    expect(ix.lastLoadError).not.toContain(tok)
  })

  it("reload forces the given source on its entries", () => {
    const ix = fresh()
    ix.reload("env", () => [{ value: tok, meta: H }])
    expect(ix.lookupValue(tok)?.source).toBe("env")
  })
})

describe("derived LRU", () => {
  it("evicts the oldest derived value past the cap and counts it", () => {
    const ix = fresh({ maxDerived: 2 })
    expect(ix.maxDerived).toBe(2)
    const vs = [1, 2, 3].map((s) => gen({ len: 16, charset: "alnum", seed: 100 + s }))
    ix.add(vs[0] as string, V)
    ix.add(vs[1] as string, V)
    ix.add(vs[0] as string, V) // touch: vs[1] is now oldest
    ix.add(vs[2] as string, V)
    expect(ix.derivedEvictions).toBe(1)
    expect(ix.lookupValue(vs[1] as string)).toBeUndefined()
    expect(ix.lookupValue(vs[0] as string)).toBeDefined()
    expect(ix.find(vs[1] as string)).toEqual([])
    expect(ix.sources().vault).toBe(2)
  })

  it("harness and env are never evicted, and do not count toward the cap", () => {
    const ix = fresh({ maxDerived: 1 })
    const h = gen({ len: 16, charset: "alnum", seed: 201 })
    const e = gen({ len: 16, charset: "alnum", seed: 202 })
    ix.add(h, H)
    ix.add(e, E)
    for (let s = 0; s < 5; s++) ix.add(gen({ len: 16, charset: "alnum", seed: 300 + s }), V)
    expect(ix.derivedEvictions).toBe(4)
    expect(ix.sources()).toEqual({ harness: 1, env: 1, vault: 1 })
    expect(ix.removeDerived(ix.lookupValue(h)?.tag as string)).toBe(false)
    expect(ix.find(`${h} ${e}`).length).toBe(2)
  })

  it("a derived value seen later as harness is promoted and leaves the LRU", () => {
    const ix = fresh({ maxDerived: 1 })
    ix.add(tok, V)
    ix.add(tok, H)
    expect(ix.lookupValue(tok)?.source).toBe("harness")
    ix.add(gen({ len: 16, charset: "alnum", seed: 9 }), V)
    expect(ix.lookupValue(tok)).toBeDefined()
    expect(ix.derivedEvictions).toBe(0)
  })

  it("setDerivedCap shrinks now, null turns the cap off", () => {
    const ix = fresh()
    expect(ix.maxDerived).toBe(50000)
    for (let s = 0; s < 5; s++) ix.add(gen({ len: 16, charset: "alnum", seed: 400 + s }), V)
    ix.setDerivedCap(2)
    expect(ix.sources().vault).toBe(2)
    expect(ix.derivedEvictions).toBe(3)
    ix.setDerivedCap(null)
    expect(ix.maxDerived).toBeNull()
    for (let s = 0; s < 50; s++) ix.add(gen({ len: 16, charset: "alnum", seed: 500 + s }), V)
    expect(ix.sources().vault).toBe(52)
    expect(ix.derivedEvictions).toBe(3)
  })

  it("removeDerived drops one derived entry by tag", () => {
    const ix = fresh()
    ix.add(tok, V)
    const tag = ix.lookupValue(tok)?.tag as string
    expect(ix.removeDerived(tag)).toBe(true)
    expect(ix.removeDerived(tag)).toBe(false)
    expect(ix.find(tok)).toEqual([])
    expect(ix.derivedEvictions).toBe(0)
  })
})

describe("perf", () => {
  it("1000 values, 1 MB text: find() median <= 50 ms (generous CI bound)", () => {
    const ix = fresh()
    const vals: string[] = []
    for (let s = 0; s < 1000; s++) {
      const v = gen({ prefix: "pf_", len: 24 + (s % 40), charset: "alnum-_", seed: 9000 + s })
      vals.push(v)
      ix.add(v, s % 2 ? H : V)
    }
    // Prose-like filler with a few planted values.
    const words = ["the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "KEY=1", "a.b"]
    const parts: string[] = []
    let len = 0
    let i = 0
    while (len < 1_000_000) {
      const w = i % 500 === 0 ? (vals[(i / 500) % 1000] as string) : (words[i % 10] as string)
      parts.push(w)
      len += w.length + 1
      i++
    }
    const text = parts.join(" ")
    ix.find("warm the index up") // build once
    for (let w = 0; w < 3; w++) ix.find(text)
    const runs: number[] = []
    let hits = 0
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now()
      hits = ix.find(text).length
      runs.push(performance.now() - t0)
    }
    runs.sort((a, b) => a - b)
    const median = runs[2] as number
    expect(hits).toBeGreaterThan(100)
    // Median of 5 runs, not a single wall time. Local median is about 3 ms. The bound
    // is loose on purpose so a slow CI host does not flake. Print with B6_PERF=1.
    expect(median).toBeLessThanOrEqual(50)
    if (process.env.B6_PERF === "1")
      process.stderr.write(
        `b6 perf median=${median.toFixed(2)}ms runs=${runs.map((r) => r.toFixed(2)).join(",")} hits=${hits}\n`,
      )
  })
})

describe("D9 match mode", () => {
  // Synthetic values only (seeded generator).
  const longSecret = gen({ prefix: "tk_", len: 37, charset: "alnum", seed: 9101 })
  const s12 = gen({ len: 12, charset: "alnum", seed: 9102 })
  const s19 = gen({ len: 19, charset: "alnum", seed: 9103 })
  const ident = gen({ len: 24, charset: "hex", seed: 9104 })
  const hex40 = gen({ len: 40, charset: "hex", seed: 9105 })
  const h = gen({ len: 32, charset: "hex", seed: 9106 })
  const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
  const envPath = "/private/var/folders/zz/abcDEF0123456789/T/agent.sock"
  const phrase = "correct horse battery staple plums"
  const V2: KnownValueMeta = { ruleId: "secret.vault-derived", kind: "secret", source: "vault" }

  it("long random secret: glued forms all match (substring mode)", () => {
    const ix = fresh()
    ix.add(longSecret, H)
    expect(ix.lookupValue(longSecret)?.mode).toBe("substring")
    expect(ix.lookupValue(longSecret)?.class).toBe("secret")
    for (const t of [
      `/bot${longSecret}/getMe`,
      `Bearer${longSecret}`,
      `?key=${longSecret}&x=1`,
      `xx${longSecret}yy`,
    ]) {
      const hits = ix.find(t)
      expect(hits.length).toBe(1)
      expect(t.slice(hits[0]?.start, hits[0]?.end)).toBe(longSecret)
    }
    const two = ix.find(`${longSecret}${longSecret}`)
    expect(two.map((x) => [x.start, x.end])).toEqual([
      [0, longSecret.length],
      [longSecret.length, 2 * longSecret.length],
    ])
  })

  it("long random env and vault values: substring mode at any start", () => {
    for (const meta of [E, V2]) {
      const ix = fresh()
      ix.add(longSecret, meta)
      expect(ix.lookupValue(longSecret)?.mode).toBe("substring")
      expect(ix.find(`a1b2${longSecret}c3`).length).toBe(1)
    }
  })

  it("base64 secret with `/` inside matches as a substring", () => {
    const ix = fresh()
    const b = `Qm9v/${gen({ len: 30, charset: "alnum", seed: 9107 })}+Zz==`
    ix.add(b, H)
    const hits = ix.find(`prefix${b}suffix`)
    expect(hits.length).toBe(1)
    expect(hits[0]?.encoding).toBe("raw")
  })

  it("12 and 19 char secrets glued: no match from every source", () => {
    for (const meta of [H, E, V2]) {
      const ix = fresh()
      ix.add(s12, meta)
      ix.add(s19, meta)
      expect(ix.lookupValue(s12)?.mode).toBe("token")
      expect(ix.lookupValue(s19)?.mode).toBe("token")
      expect(ix.find(`xx${s12}yy Bearer${s19} ${s12}z`)).toEqual([])
      expect(ix.find(`k=${s12} k=${s19}`).length).toBe(2)
    }
  })

  it("long env path value is token mode only", () => {
    const ix = fresh()
    ix.add(envPath, E)
    expect(ix.lookupValue(envPath)?.mode).toBe("token")
    expect(ix.find(`x${envPath}`)).toEqual([])
    expect(ix.find(`SOCK=${envPath}`).length).toBe(1)
  })

  it("identity value glued: no match", () => {
    const ix = fresh()
    ix.add(ident, I)
    expect(ix.lookupValue(ident)?.mode).toBe("token")
    expect(ix.lookupValue(ident)?.class).toBe("identity")
    expect(ix.find(`xx${ident}yy`)).toEqual([])
  })

  it("identity or short value in a URL path matches (`/` is a boundary)", () => {
    for (const [v, meta] of [
      [ident, I],
      [s12, H],
    ] as const) {
      const ix = fresh()
      ix.add(v, meta)
      for (const t of [`https://h/x/${v}`, `https://h/x/${v}?a=1`, `https://h/${v}/`]) {
        const hits = ix.find(t)
        expect(hits.length).toBe(1)
        expect(t.slice(hits[0]?.start, hits[0]?.end)).toBe(v)
      }
    }
  })

  it("randomness gate", () => {
    // Pinned row for the 3.0 bits threshold: 40-char random hex passes.
    expect(isRandomLooking(hex40)).toBe(true)
    expect(isRandomLooking(uuid)).toBe(true)
    expect(uuid.length).toBe(36)
    expect(isRandomLooking("abababababababababab")).toBe(false)
    expect(isRandomLooking(phrase)).toBe(false)
    expect(isRandomLooking(envPath)).toBe(false)
    expect(isRandomLooking(`~${hex40}`)).toBe(false)
    expect(isRandomLooking(`https://${hex40}`)).toBe(false)
    expect(isRandomLooking(hex40.slice(0, 19))).toBe(false)
  })

  it("a passphrase fails the gate and still matches as an exact phrase (token mode)", () => {
    const ix = fresh()
    ix.add(phrase, E)
    expect(ix.lookupValue(phrase)?.mode).toBe("token")
    expect(ix.find(`PASS="${phrase}"`).length).toBe(1)
    expect(ix.find(`x${phrase}`)).toEqual([])
  })

  it("two different known values adjacent", () => {
    const ix = fresh()
    const b = gen({ prefix: "zz_", len: 30, charset: "alnum", seed: 9108 })
    ix.add(longSecret, H)
    ix.add(b, H)
    const hits = ix.find(`${longSecret}${b}`)
    expect(hits.map((x) => x.entry.value)).toEqual([longSecret, b])
  })

  it("raw and base64 forms of the same value overlapping merge to one span", () => {
    const ix = fresh()
    const v = `sec${gen({ len: 30, charset: "alnum", seed: 9109 })}c2Vj`
    const b64 = Buffer.from(v).toString("base64")
    expect(b64.startsWith("c2Vj")).toBe(true)
    ix.add(v, H)
    const text = `${v}${b64.slice(4)}`
    const hits = ix.find(text)
    expect(hits.length).toBe(1)
    expect([hits[0]?.start, hits[0]?.end]).toEqual([0, text.length])
    expect(hits[0]?.encoding).toBe("base64")
    expect(hits[0]?.value).toBe(text)
  })

  it("fix4 (D16): a value that hits a real marker sample is refused from the index", () => {
    const ix = fresh()
    // The illustrative sample tag and the bare word appear in real marker shapes.
    expect(ix.add("1a2b3c4d", H)).toBe(false)
    expect(ix.add("REDACTED", H)).toBe(false)
    expect(ix.add("env-secret", E)).toBe(false)
    expect(ix.size).toBe(0)
  })

  it("fix3: a fake [REDACTED ...] range does not hide a planted value", () => {
    const ix = fresh()
    ix.add(longSecret, H)
    ix.add(s12, H)
    for (const t of [
      `[REDACTED fields: token=${longSecret} more]`,
      `[REDACTED stuff ${longSecret} more]`,
      `[REDACTED ${longSecret}]`,
      `[REDACTED fields: token=${s12} ...]`,
    ]) {
      const hits = ix.find(t)
      expect(hits.length).toBe(1)
      expect([longSecret, s12]).toContain(hits[0]?.value as string)
    }
    const t = `${longSecret} [REDACTED ${longSecret}] ${longSecret}`
    expect(ix.find(t).length).toBe(3)
  })

  it("counts by mode", () => {
    const ix = fresh()
    ix.add(longSecret, H)
    ix.add(s12, H)
    ix.add(ident, I)
    expect(ix.modes()).toEqual({ substring: 1, token: 2 })
  })
})

describe("fix2: one isRandomLooking (D14)", () => {
  it("known-value.ts defines and re-exports no isRandomLooking", () => {
    expect("isRandomLooking" in KV).toBe(false)
    expect("RANDOM_MIN_ENTROPY" in KV).toBe(false)
  })

  it("modeOf follows the engine gate", () => {
    const hex = gen({ len: 40, charset: "hex", seed: 9201 })
    expect(KV.modeOf(hex, E)).toBe(isRandomLooking(hex) ? "substring" : "token")
    expect(KV.modeOf("ab".repeat(15), E)).toBe("token")
  })
})

describe("fix2: tag collision (D13)", () => {
  const FAKE_TAG = "deadbeef"
  const fakeKey: SessionKey = { tag: () => FAKE_TAG }
  const a = gen({ prefix: "ca_", len: 30, charset: "alnum", seed: 9301 })
  const b = gen({ prefix: "cb_", len: 30, charset: "alnum", seed: 9302 })

  it("a tag with 2 values is ambiguous: lookupTag gives undefined, find() still hits both", () => {
    const ix = createKnownValueIndex({ key: fakeKey })
    ix.add(a, H)
    expect(ix.lookupTag(FAKE_TAG)?.value).toBe(a)
    expect(ix.tagCollisions).toBe(0)
    ix.add(b, V)
    expect(ix.lookupTag(FAKE_TAG)).toBeUndefined()
    expect(ix.tagCollisions).toBe(1)
    const hits = ix.find(`x ${a} y ${b} z`)
    expect(hits.map((h) => h.entry.value)).toEqual([a, b])
    expect(hits.every((h) => h.tag === FAKE_TAG)).toBe(true)
  })

  it("removeDerived(tag) on an ambiguous tag removes nothing, removeDerivedValue removes by value", () => {
    const ix = createKnownValueIndex({ key: fakeKey })
    ix.add(a, V)
    ix.add(b, V)
    expect(ix.removeDerived(FAKE_TAG)).toBe(false)
    expect(ix.size).toBe(2)
    expect(ix.removeDerivedValue(b)).toBe(true)
    expect(ix.lookupValue(b)).toBeUndefined()
    expect(ix.lookupTag(FAKE_TAG)?.value).toBe(a)
    expect(ix.removeDerivedValue(b)).toBe(false)
  })

  it("a key whose tag fails (null) still indexes and finds the value, with an empty tag", () => {
    const broken: SessionKey = { tag: () => null }
    const ix = createKnownValueIndex({ key: broken })
    expect(ix.add(a, H)).toBe(true)
    const hits = ix.find(`k=${a}`)
    expect(hits.length).toBe(1)
    expect(hits[0]?.tag).toBe("")
    expect(ix.lookupTag("")).toBeUndefined()
  })
})

describe("fix2: caps and options", () => {
  it("derived cap default equals the vault cap (M4)", () => {
    expect(DEFAULT_MAX_DERIVED).toBe(DEFAULT_VAULT_MAX_ENTRIES)
    expect(fresh().maxDerived).toBe(DEFAULT_VAULT_MAX_ENTRIES)
  })

  it("a fractional minLen is rejected (falls back to the floor 8)", () => {
    const ix = createKnownValueIndex({ key: memorySessionKey(), minLen: 12.5 })
    expect(ix.add("elevenchars", H)).toBe(true)
    expect(ix.add("seven77", H)).toBe(false)
  })
})

describe("fix3: substring floor from every source", () => {
  const VI: KnownValueMeta = {
    ruleId: "pii.email",
    kind: "email",
    source: "vault",
  }
  const randomId = gen({ len: 40, charset: "hex", seed: 9401 })
  const short19 = gen({ len: 19, charset: "alnum", seed: 9402 })

  it("identity values are token mode from harness, env and vault (rule or class)", () => {
    expect(isRandomLooking(randomId)).toBe(true)
    for (const meta of [
      I,
      VI,
      { ...E, class: "identity" as const },
      { ...V, class: "identity" as const },
      { ...H, ruleId: "pii.harness-identity" },
    ]) {
      const ix = fresh()
      ix.add(randomId, meta)
      expect(ix.lookupValue(randomId)?.mode).toBe("token")
      expect(ix.find(`xx${randomId}yy`)).toEqual([])
    }
  })

  it("values under 20 chars are token mode from every source", () => {
    for (const meta of [H, E, V, { ...V, class: "secret" as const }]) {
      expect(KV.modeOf(short19, meta)).toBe("token")
      const ix = fresh()
      ix.add(short19, meta)
      expect(ix.find(`xx${short19}yy`)).toEqual([])
    }
  })

  it("a vault value promoted to harness keeps the floors", () => {
    const ix = fresh()
    ix.add(short19, V)
    ix.add(short19, H)
    expect(ix.lookupValue(short19)?.mode).toBe("token")
    expect(ix.lookupValue(short19)?.source).toBe("harness")
  })

  it("fix4 (N1): promotion keeps the stronger mode, so the order does not matter", () => {
    const a = fresh()
    a.add(randomId, V)
    a.add(randomId, I)
    const b = fresh()
    b.add(randomId, I)
    b.add(randomId, V)
    expect(a.lookupValue(randomId)?.mode).toBe("substring")
    expect(b.lookupValue(randomId)?.mode).toBe("substring")
    expect(a.lookupValue(randomId)?.source).toBe("harness")
    expect(b.lookupValue(randomId)?.source).toBe("harness")
  })
})

describe("fix2: DATABASE_URL row", () => {
  const url = ["postgres", "://", "jane", ":", "fakepass", "@", "db.example.com", "/app"].join("")

  it("a :// env value fails the gate and is still indexed in token mode", () => {
    expect(isRandomLooking(url)).toBe(false)
    const ix = fresh()
    expect(ix.add(url, E)).toBe(true)
    expect(ix.lookupValue(url)?.mode).toBe("token")
  })

  it('the exact URL is found in DATABASE_URL=<url> and in "<url>"', () => {
    const ix = fresh()
    ix.add(url, E)
    const t1 = `DATABASE_URL=${url}`
    const h1 = ix.find(t1)
    expect(h1.length).toBe(1)
    expect(h1[0]?.value).toBe(url)
    expect(h1[0]?.start).toBe("DATABASE_URL=".length)
    const t2 = `conn = "${url}";`
    const h2 = ix.find(t2)
    expect(h2.length).toBe(1)
    expect(h2[0]?.value).toBe(url)
  })
})

describe("fix4 (D16): no marker skip, idempotency by test", () => {
  const key = memorySessionKey()
  const items: { value: string; meta: KnownValueMeta }[] = [
    { value: gen({ prefix: "sk-tst-", len: 60, charset: "alnum-_", seed: 9501 }), meta: H },
    { value: gen({ prefix: "tk_", len: 40, charset: "alnum", seed: 9502 }), meta: H },
    { value: gen({ len: 12, charset: "alnum", seed: 9503 }), meta: H },
    { value: gen({ len: 40, charset: "hex", seed: 9504 }), meta: E },
    { value: gen({ len: 16, charset: "alnum", seed: 9505 }), meta: E },
    { value: gen({ prefix: "vt_", len: 32, charset: "alnum", seed: 9506 }), meta: V },
    { value: gen({ len: 24, charset: "b64url", seed: 9507 }), meta: V },
    { value: gen({ len: 32, charset: "hex", seed: 9508 }), meta: I },
    { value: "jane.doe@example.com", meta: { ...I, kind: "email" } },
  ]

  it("every renderMarker and markerSamples shape gives zero known-value hits", () => {
    const ix = createKnownValueIndex({ key })
    for (const x of items) expect(ix.add(x.value, x.meta)).toBe(true)
    const kinds = ["email", "identity", "credential", "env", "secret", "anthropic.oauth-access"]
    const outs: string[] = []
    for (const k of kinds) outs.push(...markerSamples(k))
    for (const x of items) {
      for (const level of LEVELS_ON) {
        for (const tag of [key.tag(x.value), null]) {
          for (const kind of [...kinds, x.meta.kind]) {
            const base = { value: x.value, kind, tag, level }
            outs.push(renderMarker(base))
            outs.push(renderMarker({ ...base, shape: "email" }))
            outs.push(renderMarker({ ...base, render: { publicPrefix: "sk-", keepTail: true } }))
            outs.push(renderMarker({ ...base, render: { pem: true } }))
          }
        }
      }
    }
    expect(outs.length).toBeGreaterThan(1000)
    const bad = outs.filter((o) => ix.find(` ${o} `).length > 0)
    expect(bad).toEqual([])
    // Many markers in one text, also zero.
    expect(ix.find(outs.join(" "))).toEqual([])
  })

  it("an identity value in the kind slot of a marker-like text is a hit", () => {
    const ix = fresh()
    expect(ix.add("jane.doe", I)).toBe(true)
    const hits = ix.find("[REDACTED:jane.doe:00000000]")
    expect(hits.length).toBe(1)
    expect(hits[0]?.value).toBe("jane.doe")
  })

  it("a value inside `[REDACTED fields: token=<v>]` is a hit", () => {
    const hex = gen({ len: 40, charset: "hex", seed: 9509 })
    const ix = fresh()
    ix.add(hex, H)
    const hits = ix.find(`[REDACTED fields: token=${hex}]`)
    expect(hits.length).toBe(1)
    expect(hits[0]?.value).toBe(hex)
  })

  it("a tag-like value next to a real marker is a hit (no skip)", () => {
    const v = gen({ len: 24, charset: "alnum", seed: 9510 })
    const ix = fresh()
    ix.add(v, H)
    expect(ix.find(`[REDACTED:${v}]`).length).toBe(1)
  })
})

describe("fix4 (N2): a value with `@` is never substring mode", () => {
  const emails = ["jane.doe@example.com", "firstname.lastname@company.org"]
  const rows: [string, KnownValueMeta][] = [
    ["harness accessToken", H],
    ["harness apiKey", { ...H, kind: "apiKey" }],
    ["env", E],
    ["env AUTH", { ...E, kind: "env", ruleId: "secret.known-value.harness" }],
    ["vault", V],
    ["vault class secret", { ...V, class: "secret" }],
  ]
  for (const [name, meta] of rows) {
    for (const email of emails) {
      it(`${name}: ${email} stays token mode`, () => {
        expect(KV.modeOf(email, meta)).toBe("token")
        const ix = fresh()
        expect(ix.add(email, meta)).toBe(true)
        expect(ix.lookupValue(email)?.mode).toBe("token")
        expect(ix.find(`xx${email}yy`)).toEqual([])
        expect(ix.find(`to: ${email}.`).length).toBe(1)
      })
    }
  }
})

describe("fix4 (N1): a re-add keeps the stronger mode", () => {
  const long = gen({ prefix: "tk_", len: 37, charset: "alnum", seed: 9601 })

  it("identity first, then a harness secret >= 20: substring", () => {
    const ix = fresh()
    ix.add(long, I)
    expect(ix.lookupValue(long)?.mode).toBe("token")
    ix.add(long, H)
    expect(ix.lookupValue(long)?.mode).toBe("substring")
    expect(ix.lookupValue(long)?.class).toBe("secret")
    expect(ix.modes()).toEqual({ substring: 1, token: 0 })
    expect(ix.find(`xx${long}yy`).length).toBe(1)
  })

  it("harness secret first, then identity: substring stays", () => {
    const ix = fresh()
    ix.add(long, H)
    ix.add(long, I)
    expect(ix.lookupValue(long)?.mode).toBe("substring")
    expect(ix.modes()).toEqual({ substring: 1, token: 0 })
  })

  it("env token first, then a harness secret: substring, counts stay right", () => {
    const words = "correct-horse-battery-staple"
    const ix = fresh()
    ix.add(words, E)
    expect(ix.lookupValue(words)?.mode).toBe(isRandomLooking(words) ? "substring" : "token")
    ix.add(words, H)
    expect(ix.lookupValue(words)?.mode).toBe("substring")
    expect(ix.sources()).toEqual({ harness: 0, env: 1, vault: 0 })
    expect(ix.modes()).toEqual({ substring: 1, token: 0 })
  })
})
