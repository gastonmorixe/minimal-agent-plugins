import { symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { gen } from "../rules/gen.ts"
import { makeFixtureDir, removeFixtureDir } from "../test-support.ts"

import { createKnownValueIndex } from "./known-value.ts"
import { memorySessionKey } from "./session-key.ts"
import type { VaultEntry } from "./types.ts"
import {
  createVault,
  DEFAULT_VAULT_MAX_ENTRIES,
  type ReadFileFn,
  readFileCapped,
  resolveEntry,
  resolveMarker,
  VAULT_READ_CAP_BYTES,
} from "./vault.ts"

const secret = gen({ prefix: "vt_", len: 32, charset: "alnum", seed: 801 })
const ORIGIN = "/proj/.env"
const OTHER = "/proj/config.ts"

/** Fake file system for the pure rule. The strings "too-big" and "error" act as states. */
function fakeFs(files: Record<string, string>): ReadFileFn {
  return (p) => {
    const f = files[p]
    if (f === undefined) return { kind: "missing" }
    if (f === "too-big") return { kind: "too-big" }
    if (f === "error") return { kind: "error" }
    return { kind: "ok", text: f }
  }
}

const fileEntry: VaultEntry = { value: secret, origin: { kind: "file", realPath: ORIGIN } }

describe("vault LRU", () => {
  it("defaults", () => {
    const v = createVault()
    expect(v.maxEntries).toBe(DEFAULT_VAULT_MAX_ENTRIES)
    expect(v.size).toBe(0)
    expect(v.evictions).toBe(0)
  })

  it("evicts the least recently used, counts, and calls onEvict", () => {
    const evicted: string[] = []
    const v = createVault({ maxEntries: 2, onEvict: (t) => evicted.push(t) })
    v.put("aaaaaaaa", { value: "value-aaaa", origin: { kind: "none" } })
    v.put("bbbbbbbb", { value: "value-bbbb", origin: { kind: "env" } })
    expect(v.get("aaaaaaaa")?.value).toBe("value-aaaa") // a is now recent
    v.put("cccccccc", { value: "value-cccc", origin: { kind: "auth.jsonc" } })
    expect(v.has("bbbbbbbb")).toBe(false)
    expect(v.has("aaaaaaaa")).toBe(true)
    expect(v.evictions).toBe(1)
    expect(evicted).toEqual(["bbbbbbbb"])
    expect(v.size).toBe(2)
  })

  it("a throwing onEvict does not break put", () => {
    const v = createVault({ maxEntries: 1 })
    v.onEvict = () => {
      throw new Error("boom")
    }
    v.put("t1t1t1t1", { value: "value-1111", origin: { kind: "none" } })
    expect(() => v.put("t2t2t2t2", { value: "value-2222", origin: { kind: "none" } })).not.toThrow()
    expect(v.evictions).toBe(1)
    v.onEvict = undefined
  })

  it("put adds the value to the index as derived with the same tag", () => {
    const key = memorySessionKey()
    const ix = createKnownValueIndex({ key })
    const v = createVault({ index: ix })
    v.put(key.tag(secret) as string, fileEntry)
    const e = ix.lookupValue(secret)
    expect(e?.source).toBe("vault")
    expect(e?.tag).toBe(key.tag(secret) as string)
    expect(ix.find(`X=${secret}`).length).toBe(1)
  })

  it("onEvict can drop the derived known value", () => {
    const key = memorySessionKey()
    const ix = createKnownValueIndex({ key })
    const v = createVault({ index: ix, maxEntries: 1 })
    v.onEvict = (tag) => {
      ix.removeDerived(tag)
    }
    const other = gen({ len: 20, charset: "alnum", seed: 9 })
    v.put(key.tag(secret) as string, fileEntry)
    v.put(key.tag(other) as string, { value: other, origin: { kind: "none" } })
    expect(ix.lookupValue(secret)).toBeUndefined()
    expect(ix.lookupValue(other)).toBeDefined()
  })
})

describe("fix2: vault tag collision (D13)", () => {
  const a = gen({ prefix: "va_", len: 30, charset: "alnum", seed: 811 })
  const b = gen({ prefix: "vb_", len: 30, charset: "alnum", seed: 812 })
  const T = "deadbeef"

  it("keeps every value per tag, an ambiguous tag never swaps", () => {
    const v = createVault()
    v.put(T, { value: a, origin: { kind: "file", realPath: ORIGIN } })
    expect(v.tagCollisions).toBe(0)
    v.put(T, { value: b, origin: { kind: "file", realPath: ORIGIN } })
    expect(v.tagCollisions).toBe(1)
    expect(v.has(T)).toBe(true)
    expect(v.size).toBe(1)
    const fs = fakeFs({ [ORIGIN]: `${a} ${b}` })
    expect(resolveMarker(v, T, "Edit", ORIGIN, fs)).toEqual({ reason: "ambiguous tag" })
    expect(resolveMarker(v, T, "Write", ORIGIN, fs)).toEqual({ reason: "ambiguous tag" })
    expect(v.get(T)).toBeUndefined()
    expect(v.originMatches(T, ORIGIN)).toBe(false)
    // Same value again is not a new collision.
    v.put(T, { value: a, origin: { kind: "none" } })
    expect(v.tagCollisions).toBe(1)
  })

  it("index: both colliding values still redact (match by value)", () => {
    const fakeKey = { tag: () => T }
    const ix = createKnownValueIndex({ key: fakeKey })
    const v = createVault({ index: ix })
    v.put(T, { value: a, origin: { kind: "none" } })
    v.put(T, { value: b, origin: { kind: "none" } })
    expect(ix.tagCollisions).toBe(1)
    expect(ix.find(`${a} and ${b}`).map((h) => h.entry.value)).toEqual([a, b])
  })
})

describe("fix2: caps (M4, M5)", () => {
  it("eviction syncs the owned index internally, without onEvict", () => {
    const key = memorySessionKey()
    const ix = createKnownValueIndex({ key })
    const v = createVault({ index: ix, maxEntries: 2 })
    const vals = [811, 812, 813].map((s) =>
      gen({ prefix: "cap_", len: 24, charset: "alnum", seed: s }),
    )
    for (const x of vals) v.put(key.tag(x) as string, { value: x, origin: { kind: "none" } })
    expect(v.size).toBe(2)
    expect(ix.sources().vault).toBe(2)
    expect(ix.lookupValue(vals[0] as string)).toBeUndefined()
    expect(ix.lookupValue(vals[2] as string)).toBeDefined()
  })

  it("fix4 (N8): an owned index has no derived cap, a collision never evicts a held value", () => {
    const T = "deadbeef"
    const ix = createKnownValueIndex({ key: { tag: () => T }, maxDerived: 2 })
    const v = createVault({ index: ix, maxEntries: 2 })
    expect(ix.maxDerived).toBeNull()
    const vals = [1901, 1902, 1903, 1904].map((s) =>
      gen({ prefix: "col_", len: 24, charset: "alnum", seed: s }),
    )
    // 4 distinct values under 1 tag: the vault holds 1 tag, the index must keep all 4.
    for (const x of vals) v.put(T, { value: x, origin: { kind: "none" } })
    expect(v.size).toBe(1)
    for (const x of vals) expect(ix.lookupValue(x)?.source).toBe("vault")
    expect(ix.derivedEvictions).toBe(0)
  })

  it("fix4: the floor ruleId and kind passed to put reach the index entry", () => {
    const key = memorySessionKey()
    const ix = createKnownValueIndex({ key })
    const v = createVault({ index: ix })
    const x = gen({ prefix: "fl_", len: 30, charset: "alnum", seed: 1910 })
    v.put(
      key.tag(x) as string,
      { value: x, origin: { kind: "none" } },
      {
        ruleId: "aws.secret-key",
        kind: "aws-secret",
      },
    )
    expect(ix.lookupValue(x)?.ruleId).toBe("aws.secret-key")
    expect(ix.lookupValue(x)?.kind).toBe("aws-secret")
    const hits = ix.find(`k=${x}`)
    expect(hits[0]?.ruleId).toBe("aws.secret-key")
    // A pii floor makes the derived value identity class, token mode.
    const p = gen({ len: 40, charset: "hex", seed: 1911 })
    v.put(
      key.tag(p) as string,
      { value: p, origin: { kind: "none" } },
      {
        ruleId: "pii.email",
        kind: "email",
      },
    )
    expect(ix.lookupValue(p)?.class).toBe("identity")
    expect(ix.lookupValue(p)?.mode).toBe("token")
  })

  it("no cap drift: the vault owns eviction, both stay in step", () => {
    const key = memorySessionKey()
    const ix = createKnownValueIndex({ key, maxDerived: 3 })
    const v = createVault({ index: ix, maxEntries: 5 })
    expect(ix.maxDerived).toBeNull()
    const vals: string[] = []
    for (let s = 0; s < 20; s++) {
      const x = gen({ prefix: "drift_", len: 24, charset: "alnum", seed: 900 + s })
      vals.push(x)
      v.put(key.tag(x) as string, { value: x, origin: { kind: "none" } })
      expect(ix.sources().vault).toBe(v.size)
    }
    // Every value still in the vault is still redacted by the index.
    for (const x of vals.slice(-5)) expect(ix.lookupValue(x)).toBeDefined()
    for (const x of vals.slice(0, -5)) expect(ix.lookupValue(x)).toBeUndefined()
  })

  it("an evicted index entry that is still a harness value stays", () => {
    const key = memorySessionKey()
    const ix = createKnownValueIndex({ key })
    const v = createVault({ index: ix, maxEntries: 1 })
    const h = gen({ prefix: "hv_", len: 24, charset: "alnum", seed: 777 })
    ix.add(h, { ruleId: "secret.known-value.harness", kind: "credential", source: "harness" })
    v.put(key.tag(h) as string, { value: h, origin: { kind: "none" } })
    const o = gen({ prefix: "ov_", len: 24, charset: "alnum", seed: 778 })
    v.put(key.tag(o) as string, { value: o, origin: { kind: "none" } })
    expect(ix.lookupValue(h)?.source).toBe("harness")
  })
})

describe("fix3: ref-counted eviction keeps harness and env values", () => {
  const meta = {
    harness: { ruleId: "secret.known-value.harness", kind: "credential", source: "harness" },
    env: { ruleId: "secret.known-value.harness", kind: "env", source: "env" },
  } as const

  for (const src of ["harness", "env"] as const) {
    it(`${src}: evict, re-add, evict again: the ${src} entry stays and still matches`, () => {
      const key = memorySessionKey()
      const ix = createKnownValueIndex({ key })
      const v = createVault({ index: ix, maxEntries: 1 })
      const x = gen({ prefix: "rx_", len: 24, charset: "alnum", seed: src === "env" ? 1801 : 1802 })
      const o1 = gen({ prefix: "o1_", len: 24, charset: "alnum", seed: 1803 })
      const o2 = gen({ prefix: "o2_", len: 24, charset: "alnum", seed: 1804 })
      ix.add(x, meta[src])
      const tx = key.tag(x) as string
      v.put(tx, { value: x, origin: { kind: "none" } })
      v.put(key.tag(o1) as string, { value: o1, origin: { kind: "none" } })
      expect(v.has(tx)).toBe(false)
      expect(ix.lookupValue(x)?.source).toBe(src)
      v.put(tx, { value: x, origin: { kind: "none" } })
      expect(v.get(tx)?.value).toBe(x)
      v.put(key.tag(o2) as string, { value: o2, origin: { kind: "none" } })
      expect(ix.lookupValue(x)?.source).toBe(src)
      expect(ix.find(`k=${x}`).length).toBe(1)
      expect(ix.sources()[src]).toBe(1)
    })
  }

  it("a vault value promoted to env after the put survives its eviction", () => {
    const key = memorySessionKey()
    const ix = createKnownValueIndex({ key })
    const v = createVault({ index: ix, maxEntries: 1 })
    const x = gen({ prefix: "px_", len: 24, charset: "alnum", seed: 1805 })
    v.put(key.tag(x) as string, { value: x, origin: { kind: "none" } })
    ix.add(x, meta.env)
    const o = gen({ prefix: "po_", len: 24, charset: "alnum", seed: 1806 })
    v.put(key.tag(o) as string, { value: o, origin: { kind: "none" } })
    expect(ix.lookupValue(x)?.source).toBe("env")
  })

  it("a value held by 2 tags stays until the last tag goes, then a re-add restores it", () => {
    const ix = createKnownValueIndex({ key: memorySessionKey() })
    const v = createVault({ index: ix, maxEntries: 2 })
    const x = gen({ prefix: "tt_", len: 24, charset: "alnum", seed: 1807 })
    const f1 = gen({ prefix: "f1_", len: 24, charset: "alnum", seed: 1808 })
    const f2 = gen({ prefix: "f2_", len: 24, charset: "alnum", seed: 1809 })
    v.put("aaaaaaaa", { value: x, origin: { kind: "none" } })
    v.put("bbbbbbbb", { value: x, origin: { kind: "none" } })
    v.put("cccccccc", { value: f1, origin: { kind: "none" } })
    expect(v.has("aaaaaaaa")).toBe(false)
    expect(ix.lookupValue(x)).toBeDefined()
    v.put("dddddddd", { value: f2, origin: { kind: "none" } })
    expect(ix.lookupValue(x)).toBeUndefined()
    v.put("aaaaaaaa", { value: x, origin: { kind: "none" } })
    expect(ix.lookupValue(x)?.source).toBe("vault")
  })
})

describe("fix3: readFileCapped uses the safe single-fd read", () => {
  const dir = makeFixtureDir("b6-vault-rd-")
  afterAll(() => removeFixtureDir(dir))

  it("a symlink target is refused (never followed)", () => {
    const real = join(dir, "real.txt")
    writeFileSync(real, `x ${secret}`)
    const link = join(dir, "link.txt")
    symlinkSync(real, link)
    expect(readFileCapped(link, 1000)).toEqual({ kind: "error" })
    expect(readFileCapped(real, 1000)).toEqual({ kind: "ok", text: `x ${secret}` })
  })

  it("a dir is an error, a missing file is missing, over the cap is too-big", () => {
    expect(readFileCapped(dir, 1000)).toEqual({ kind: "error" })
    expect(readFileCapped(join(dir, "nope.txt"), 1000)).toEqual({ kind: "missing" })
    const big = join(dir, "big.txt")
    writeFileSync(big, "a".repeat(101))
    expect(readFileCapped(big, 100)).toEqual({ kind: "too-big" })
    expect(readFileCapped(big, 101)).toEqual({ kind: "ok", text: "a".repeat(101) })
  })
})

describe("fix2: read cap compares bytes", () => {
  it("a multi-byte text over the byte cap is too-big even when its char length is under", () => {
    const text = `${secret} ${"é".repeat(60)}`
    expect(text.length).toBeLessThan(100)
    expect(Buffer.byteLength(text)).toBeGreaterThan(100)
    const fs: ReadFileFn = () => ({ kind: "ok", text })
    expect(resolveEntry(fileEntry, "Edit", OTHER, fs, 100)).toEqual({ reason: "too-big" })
  })
})

describe("unified rule: Edit", () => {
  it("resolves on the origin even when the value is gone from the file", () => {
    const fs = fakeFs({ [ORIGIN]: "nothing here" })
    expect(resolveEntry(fileEntry, "Edit", ORIGIN, fs)).toEqual({ value: secret })
  })

  it("resolves on another file when the value is in it now", () => {
    const fs = fakeFs({ [OTHER]: `const k = "${secret}"` })
    expect(resolveEntry(fileEntry, "Edit", OTHER, fs)).toEqual({ value: secret })
  })

  it("does not resolve on another file without the value", () => {
    const fs = fakeFs({ [OTHER]: "const k = 1" })
    expect(resolveEntry(fileEntry, "Edit", OTHER, fs)).toEqual({ reason: "not-in-target" })
  })

  it("missing target and file over the read cap fail the in-file rule", () => {
    expect(resolveEntry(fileEntry, "Edit", OTHER, fakeFs({}))).toEqual({
      reason: "target-missing",
    })
    expect(resolveEntry(fileEntry, "Edit", OTHER, fakeFs({ [OTHER]: "too-big" }))).toEqual({
      reason: "too-big",
    })
    expect(resolveEntry(fileEntry, "Edit", OTHER, fakeFs({ [OTHER]: "error" }))).toEqual({
      reason: "read-error",
    })
  })
})

describe("unified rule: Write", () => {
  it("resolves on the origin that exists and holds the value", () => {
    const fs = fakeFs({ [ORIGIN]: `API_KEY=${secret}\n` })
    expect(resolveEntry(fileEntry, "Write", ORIGIN, fs)).toEqual({ value: secret })
  })

  it("origin without the value, missing origin, origin over the cap", () => {
    expect(resolveEntry(fileEntry, "Write", ORIGIN, fakeFs({ [ORIGIN]: "API_KEY=x" }))).toEqual({
      reason: "not-in-target",
    })
    expect(resolveEntry(fileEntry, "Write", ORIGIN, fakeFs({}))).toEqual({
      reason: "target-missing",
    })
    expect(resolveEntry(fileEntry, "Write", ORIGIN, fakeFs({ [ORIGIN]: "too-big" }))).toEqual({
      reason: "too-big",
    })
  })

  it("never resolves on a non-origin file, even when the value is in it", () => {
    const fs = fakeFs({ [OTHER]: secret })
    expect(resolveEntry(fileEntry, "Write", OTHER, fs)).toEqual({ reason: "not-origin" })
  })
})

describe("unified rule: known-value origins", () => {
  for (const kind of ["auth.jsonc", "env", "none"] as const) {
    const entry: VaultEntry = { value: secret, origin: { kind } }
    it(`${kind}: Edit only by value in target`, () => {
      expect(resolveEntry(entry, "Edit", OTHER, fakeFs({ [OTHER]: `x ${secret} y` }))).toEqual({
        value: secret,
      })
      expect(resolveEntry(entry, "Edit", OTHER, fakeFs({ [OTHER]: "x" }))).toEqual({
        reason: "not-in-target",
      })
    })
    it(`${kind}: Write never resolves`, () => {
      expect(resolveEntry(entry, "Write", OTHER, fakeFs({ [OTHER]: secret }))).toEqual({
        reason: "not-origin",
      })
    })
  }
})

describe("resolveMarker", () => {
  it("looks up the tag, rejects unknown tags and other tools", () => {
    const v = createVault()
    v.put("abcd1234", fileEntry)
    const fs = fakeFs({ [ORIGIN]: secret })
    expect(resolveMarker(v, "abcd1234", "Edit", ORIGIN, fs)).toEqual({ value: secret })
    expect(resolveMarker(v, "ffff0000", "Edit", ORIGIN, fs)).toEqual({ reason: "unknown-tag" })
    expect(resolveMarker(v, "abcd1234", "Fetch", ORIGIN, fs)).toEqual({
      reason: "unsupported-tool",
    })
  })

  it("a throwing reader gives read-error, never a throw", () => {
    const bad: ReadFileFn = () => {
      throw new Error("x")
    }
    expect(resolveEntry(fileEntry, "Write", ORIGIN, bad)).toEqual({ reason: "read-error" })
  })
})

describe("integration: real files", () => {
  const root = makeFixtureDir("b6-vault-")
  afterAll(() => removeFixtureDir(root))

  it("readFileCapped: ok, missing, over the cap", () => {
    const small = join(root, "small.env")
    const big = join(root, "big.txt")
    writeFileSync(small, `TOKEN=${secret}\n`)
    writeFileSync(big, Buffer.alloc(VAULT_READ_CAP_BYTES + 1, 0x61))
    const entry: VaultEntry = { value: secret, origin: { kind: "file", realPath: small } }
    expect(resolveEntry(entry, "Write", small)).toEqual({ value: secret })
    expect(resolveEntry(entry, "Edit", big)).toEqual({ reason: "too-big" })
    expect(resolveEntry(entry, "Edit", join(root, "nope"))).toEqual({ reason: "target-missing" })
    expect(readFileCapped(root, 10)).toEqual({ kind: "error" })
  })
})

describe("originMatches", () => {
  it("true only for a file origin with the same real path, no LRU touch", () => {
    const v = createVault({ maxEntries: 2 })
    v.put("t1", { value: secret, origin: { kind: "file", realPath: ORIGIN } })
    v.put("t2", { value: `${secret}x`, origin: { kind: "env" } })
    expect(v.originMatches("t1", ORIGIN)).toBe(true)
    expect(v.originMatches("t1", OTHER)).toBe(false)
    expect(v.originMatches("t2", ORIGIN)).toBe(false)
    expect(v.originMatches("nope", ORIGIN)).toBe(false)
    // No touch: t1 stays the oldest and is evicted next.
    v.put("t3", { value: `${secret}y`, origin: { kind: "none" } })
    expect(v.has("t1")).toBe(false)
    expect(v.originMatches(null as unknown as string, ORIGIN)).toBe(false)
  })
})
