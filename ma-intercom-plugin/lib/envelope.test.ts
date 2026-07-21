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
  it("accepts message and interrupt, rejects others", () => {
    expect(isMessageKind("message")).toBe(true)
    expect(isMessageKind("interrupt")).toBe(true)
    expect(isMessageKind("shout")).toBe(false)
    expect(isMessageKind("note")).toBe(false)
    expect(isMessageKind("ping")).toBe(false)
    expect(isMessageKind(5)).toBe(false)
  })
})

describe("buildEnvelope", () => {
  it("builds a complete envelope and omits replyTo when absent", () => {
    const e = buildEnvelope({
      from: FROM,
      to: "cccc",
      scope: "cccc",
      kind: "message",
      body: "hi",
      nowMs: 1_700_000_000_000,
    })
    expect(e.v).toBe(1)
    expect(e.from.short).toBe("bbbbbb")
    expect(e.to).toBe("cccc")
    expect(e.kind).toBe("message")
    expect(e.body).toBe("hi")
    expect("replyTo" in e).toBe(false)
    expect(e.ts).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it("keeps replyTo when given", () => {
    const e = buildEnvelope({
      from: FROM,
      to: "c",
      scope: "c",
      kind: "message",
      body: "y",
      replyTo: "abc-1-0000",
    })
    expect(e.replyTo).toBe("abc-1-0000")
  })

  it("clamps only absurdly oversized bodies (safety ceiling, not PIPE_BUF)", () => {
    // A large-but-reasonable body (well under the safety ceiling) must pass
    // through intact — coordination messages routinely exceed the old 3.5k
    // PIPE_BUF-era limit.
    const large = "x".repeat(50_000)
    const ok = buildEnvelope({ from: FROM, to: "c", scope: "c", kind: "message", body: large })
    expect(ok.body).toBe(large)
    expect(ok.body).not.toContain("truncated")

    // Only the runaway multi-megabyte case is clipped, with a visible marker.
    const huge = "x".repeat(300_000)
    const e = buildEnvelope({ from: FROM, to: "c", scope: "c", kind: "message", body: huge })
    expect(e.body.length).toBeLessThan(huge.length)
    expect(e.body).toContain("truncated")
    // Safety ceiling is 256_000 body chars + a short truncation notice.
    expect(e.body.length).toBeLessThan(256_000 + 64)
  })

  it("does not throw on a non-finite nowMs", () => {
    expect(() =>
      buildEnvelope({
        from: FROM,
        to: "c",
        scope: "c",
        kind: "message",
        body: "x",
        nowMs: Number.NaN,
      }),
    ).not.toThrow()
  })
})

describe("coerceEnvelope path-traversal guard", () => {
  it("rejects an envelope whose from.sid is a path-traversal string", () => {
    const ok = buildEnvelope({ from: FROM, to: "c", scope: "c", kind: "message", body: "x" })
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

  it("preserves optional from.name and clamps it; omits blank names", () => {
    const named = buildEnvelope({
      from: { ...FROM, name: "Sergio" },
      to: "c",
      scope: "c",
      kind: "message",
      body: "hi",
    })
    const back = coerceEnvelope(JSON.parse(serializeEnvelope(named).trim()))
    expect(back?.from.name).toBe("Sergio")

    const raw = JSON.parse(serializeEnvelope(named).trim()) as Record<string, unknown>
    ;(raw.from as Record<string, unknown>).name = `  ${"A".repeat(60)}  `
    const clamped = coerceEnvelope(raw)
    expect(clamped?.from.name).toBe("A".repeat(48))

    ;(raw.from as Record<string, unknown>).name = "   "
    const blank = coerceEnvelope(raw)
    expect(blank?.from.name).toBeUndefined()
  })

  it("rejects objects missing id / body / kind / from.sid", () => {
    expect(coerceEnvelope({ body: "x", kind: "message", from: { sid: "s" } })).toBeNull() // no id
    expect(coerceEnvelope({ id: "i", kind: "message", from: { sid: "s" } })).toBeNull() // no body
    expect(coerceEnvelope({ id: "i", body: "b", kind: "bad", from: { sid: "s" } })).toBeNull() // bad kind
    expect(coerceEnvelope({ id: "i", body: "b", kind: "message", from: {} })).toBeNull() // no from.sid
  })

  it("defaults scope to `to` when scope missing (back-compat)", () => {
    const back = coerceEnvelope({
      id: "i",
      body: "b",
      kind: "message",
      to: "ddd",
      from: { sid: "s" },
    })
    expect(back?.scope).toBe("ddd")
  })
})

describe("parseInbox", () => {
  it("tolerates blank lines, junk, and a torn last line", () => {
    const good = serializeEnvelope(
      buildEnvelope({ from: FROM, to: "c", scope: "c", kind: "message", body: "one" }),
    )
    const good2 = serializeEnvelope(
      buildEnvelope({ from: FROM, to: "c", scope: "c", kind: "message", body: "two" }),
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
        buildEnvelope({ from: FROM, to: "c", scope: "c", kind: "message", body: b, nowMs: 1 }),
      )
    }
    expect(parseInbox(blob).map((e) => e.body)).toEqual(["a", "b", "c"])
  })
})
