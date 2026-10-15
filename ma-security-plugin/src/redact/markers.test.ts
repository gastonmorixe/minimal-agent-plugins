import { describe, expect, it } from "bun:test"

import { gen } from "../rules/gen.ts"

import { emailLow, lowTail, markerCore, renderMarker, tailLength } from "./markers.ts"

const TAG = "1a2b3c4d"
const ETAG = "9f8e7d6c"
const PREFIX = "sk-ant-oat01-"
// Synthetic token shape: public prefix plus 95 generated chars (108 total).
const token = gen({ prefix: PREFIX, len: 95, charset: "alnum-_", seed: 1234 })
const kind = "anthropic.oauth-access"
const render = { publicPrefix: PREFIX, keepTail: true }
const email = "jane.doe@example.com"

describe("token markers", () => {
  const at = (level: "off" | "low" | "mid" | "high" | "xhigh", tag: string | null = TAG) =>
    renderMarker({ value: token, kind, tag, level, render })

  it("matches the SPEC-v3 level table", () => {
    expect(token.length).toBe(108)
    expect(at("off")).toBe(token)
    expect(at("low")).toBe(`${PREFIX}[REDACTED:${kind}:${TAG}]${token.slice(-4)}`)
    expect(at("mid")).toBe(`${PREFIX}[REDACTED:${kind}:${TAG}]`)
    expect(at("high")).toBe(`[REDACTED:${kind}:${TAG}]`)
    expect(at("xhigh")).toBe(`[REDACTED:${TAG}]`)
  })

  it("prints a bare marker with tag off", () => {
    expect(at("high", null)).toBe("[REDACTED]")
    expect(at("mid", null)).toBe(`${PREFIX}[REDACTED]`)
  })

  it("keeps no tail under 16 chars and no head of the random part", () => {
    expect(tailLength(15)).toBe(0)
    expect(tailLength(32)).toBe(2)
    expect(tailLength(200)).toBe(4)
    const short = gen({ len: 12, charset: "alnum", seed: 5 })
    expect(
      renderMarker({ value: short, kind: "x", tag: TAG, level: "low", render: { keepTail: true } }),
    ).toBe(`[REDACTED:x:${TAG}]`)
  })

  it("M3: tail comes from the random part and keeps 12+ hidden chars", () => {
    const low = (value: string) => renderMarker({ value, kind, tag: TAG, level: "low", render })
    // 3 random chars: no tail.
    const t3 = gen({ prefix: PREFIX, len: 3, charset: "alnum", seed: 11 })
    expect(low(t3)).toBe(`${PREFIX}[REDACTED:${kind}:${TAG}]`)
    // 16 random chars: tail 1 leaves 15 hidden.
    const t16 = gen({ prefix: PREFIX, len: 16, charset: "alnum", seed: 12 })
    expect(low(t16)).toBe(`${PREFIX}[REDACTED:${kind}:${TAG}]${t16.slice(-1)}`)
    // 20 random chars: tail 1 (floor(20/16)), not 2 from the full length 33.
    const t20 = gen({ prefix: PREFIX, len: 20, charset: "alnum", seed: 13 })
    expect(low(t20)).toBe(`${PREFIX}[REDACTED:${kind}:${TAG}]${t20.slice(-1)}`)
    // lowTail helper: 12-char floor.
    expect(lowTail(15)).toBe(0)
    expect(lowTail(16)).toBe(1)
    expect(lowTail(64)).toBe(4)
    expect(lowTail(63)).toBe(3)
  })

  it("ignores a public prefix the value does not have", () => {
    const v = gen({ prefix: "other-", len: 40, charset: "alnum", seed: 6 })
    expect(renderMarker({ value: v, kind, tag: TAG, level: "mid", render })).toBe(
      `[REDACTED:${kind}:${TAG}]`,
    )
  })

  it("keeps PEM BEGIN and END lines at low and mid", () => {
    const body = gen({ len: 64, charset: "b64url", seed: 8 })
    const pem = `-----BEGIN FAKE KEY-----\n${body}\n-----END FAKE KEY-----`
    const out = renderMarker({
      value: pem,
      kind: "pem",
      tag: TAG,
      level: "mid",
      render: { pem: true },
    })
    expect(out).toBe(`-----BEGIN FAKE KEY-----\n[REDACTED:pem:${TAG}]\n-----END FAKE KEY-----`)
  })
})

describe("email markers", () => {
  const at = (level: "low" | "mid" | "high" | "xhigh") =>
    renderMarker({ value: email, kind: "email", tag: ETAG, level, shape: "email" })

  it("matches the SPEC-v3 level table", () => {
    expect(at("low")).toBe(`ja[...]@ex[...]le.com#${ETAG}`)
    expect(at("mid")).toBe(`[REDACTED:email:${ETAG}]@example.com`)
    expect(at("high")).toBe(`[REDACTED:email:${ETAG}]`)
    expect(at("xhigh")).toBe(`[REDACTED:${ETAG}]`)
  })

  it("shows the first char only for short parts and keeps later labels", () => {
    expect(emailLow("bob@mail.co.uk", ETAG)).toBe(`b[...]@m[...].co.uk#${ETAG}`)
    expect(emailLow("bob@mail.co.uk", null)).toBe("b[...]@m[...].co.uk")
  })

  it("core marker shapes", () => {
    expect(markerCore("k", TAG, "mid")).toBe(`[REDACTED:k:${TAG}]`)
    expect(markerCore("k", TAG, "xhigh")).toBe(`[REDACTED:${TAG}]`)
  })
})
