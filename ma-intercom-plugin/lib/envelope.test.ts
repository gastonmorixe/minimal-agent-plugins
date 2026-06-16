import { describe, expect, it } from "bun:test"

import {
  buildEnvelope,
  coerceEnvelope,
  type EnvelopeFrom,
  isMessageKind,
  makeEnvelopeId,
  parseInbox,
  serializeEnvelope,
} from "./envelope.ts"

const FROM: EnvelopeFrom = {
  sid: "bbbbbbbb-2222",
  short: "bbbbbb",
  pid: 99,
  host: "h",
  cwd: "/work",
  model: "claude-opus-4-8",
}

describe("makeEnvelopeId", () => {
  it("is deterministic given clock + rand, with a 32-bit (8-hex) random suffix", () => {
    const id = makeEnvelopeId("bbbbbb", 1_000_000, () => 0.5)
    expect(id).toMatch(/^bbbbbb-[0-9a-z]+-[0-9a-f]{8}$/)
    expect(makeEnvelopeId("bbbbbb", 1_000_000, () => 0.5)).toBe(id)
  })

  it("distinct rand draws yield distinct ids in the same ms (collision resistance)", () => {
    let n = 0
    const seq = () => [0.1, 0.9, 0.2, 0.8][n++ % 4] as number
    const a = makeEnvelopeId("x", 1_000_000, seq)
    const b = makeEnvelopeId("x", 1_000_000, seq)
    expect(a).not.toBe(b)
  })

  it("sorts by time for one sender for same-length (same-era) timestamps", () => {
    // Real epoch-ms timestamps in the same era share a base36 length, so the
    // ms prefix sorts lexically. (Cross-length base36 doesn't, but inbox order
    // is append order anyway — the id sort is a convenience, not the contract.)
    const a = makeEnvelopeId("x", 1_700_000_000_000, () => 0)
    const b = makeEnvelopeId("x", 1_700_000_001_000, () => 0)
    expect(a < b).toBe(true)
    expect(a.length).toBe(b.length)
  })
})

describe("isMessageKind", () => {
  it("accepts the three kinds and rejects others", () => {
    expect(isMessageKind("note")).toBe(true)
    expect(isMessageKind("ping")).toBe(true)
    expect(isMessageKind("interrupt")).toBe(true)
    expect(isMessageKind("shout")).toBe(false)
    expect(isMessageKind(5)).toBe(false)
  })
})

describe("buildEnvelope", () => {
  it("builds a complete envelope and omits replyTo when absent", () => {
    const e = buildEnvelope({
      from: FROM,
      to: "cccc",
      scope: "cccc",
      kind: "note",
      body: "hi",
      nowMs: 1_700_000_000_000,
    })
    expect(e.v).toBe(1)
    expect(e.from.short).toBe("bbbbbb")
    expect(e.to).toBe("cccc")
    expect(e.kind).toBe("note")
    expect(e.body).toBe("hi")
    expect("replyTo" in e).toBe(false)
    expect(e.ts).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it("keeps replyTo when given", () => {
    const e = buildEnvelope({
      from: FROM,
      to: "c",
      scope: "c",
      kind: "ping",
      body: "y",
      replyTo: "abc-1-0000",
    })
    expect(e.replyTo).toBe("abc-1-0000")
  })

  it("clamps an oversized body so the JSONL line stays append-atomic", () => {
    const huge = "x".repeat(10_000)
    const e = buildEnvelope({ from: FROM, to: "c", scope: "c", kind: "note", body: huge })
    expect(e.body.length).toBeLessThan(huge.length)
    expect(e.body).toContain("truncated")
    expect(serializeEnvelope(e).length).toBeLessThan(4096)
  })

  it("does not throw on a non-finite nowMs", () => {
    expect(() =>
      buildEnvelope({
        from: FROM,
        to: "c",
        scope: "c",
        kind: "note",
        body: "x",
        nowMs: Number.NaN,
      }),
    ).not.toThrow()
  })
})

describe("coerceEnvelope path-traversal guard", () => {
  it("rejects an envelope whose from.sid is a path-traversal string", () => {
    const ok = buildEnvelope({ from: FROM, to: "c", scope: "c", kind: "note", body: "x" })
    const raw = JSON.parse(serializeEnvelope(ok).trim()) as Record<string, unknown>
    ;(raw.from as Record<string, unknown>).sid = "../../../etc/evil"
    expect(coerceEnvelope(raw)).toBeNull()
  })
})

describe("coerceEnvelope", () => {
  it("round-trips a serialized envelope", () => {
    const e = buildEnvelope({ from: FROM, to: "c", scope: "all", kind: "interrupt", body: "stop" })
    const back = coerceEnvelope(JSON.parse(serializeEnvelope(e).trim()))
    expect(back).not.toBeNull()
    expect(back?.id).toBe(e.id)
    expect(back?.kind).toBe("interrupt")
    expect(back?.from.sid).toBe(FROM.sid)
  })

  it("rejects objects missing id / body / kind / from.sid", () => {
    expect(coerceEnvelope({ body: "x", kind: "note", from: { sid: "s" } })).toBeNull() // no id
    expect(coerceEnvelope({ id: "i", kind: "note", from: { sid: "s" } })).toBeNull() // no body
    expect(coerceEnvelope({ id: "i", body: "b", kind: "bad", from: { sid: "s" } })).toBeNull() // bad kind
    expect(coerceEnvelope({ id: "i", body: "b", kind: "note", from: {} })).toBeNull() // no from.sid
  })

  it("defaults scope to `to` when scope missing (back-compat)", () => {
    const back = coerceEnvelope({ id: "i", body: "b", kind: "note", to: "ddd", from: { sid: "s" } })
    expect(back?.scope).toBe("ddd")
  })
})

describe("parseInbox", () => {
  it("tolerates blank lines, junk, and a torn last line", () => {
    const good = serializeEnvelope(
      buildEnvelope({ from: FROM, to: "c", scope: "c", kind: "note", body: "one" }),
    )
    const good2 = serializeEnvelope(
      buildEnvelope({ from: FROM, to: "c", scope: "c", kind: "note", body: "two" }),
    )
    const text = `\n${good}garbage-not-json\n${good2}{"torn":` // last line torn
    const out = parseInbox(text)
    expect(out.length).toBe(2)
    expect(out[0]?.body).toBe("one")
    expect(out[1]?.body).toBe("two")
  })

  it("preserves append order", () => {
    let blob = ""
    for (const b of ["a", "b", "c"]) {
      blob += serializeEnvelope(
        buildEnvelope({ from: FROM, to: "c", scope: "c", kind: "note", body: b, nowMs: 1 }),
      )
    }
    expect(parseInbox(blob).map((e) => e.body)).toEqual(["a", "b", "c"])
  })
})
