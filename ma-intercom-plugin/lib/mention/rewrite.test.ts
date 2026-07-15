import { describe, expect, it } from "bun:test"

import type { Liveness } from "../liveness.ts"

import { peerXml, resolveMentionPeer, rewriteMentions } from "./rewrite.ts"
import type { PeerCandidate } from "./types.ts"

function peer(
  partial: Partial<PeerCandidate> & Pick<PeerCandidate, "sid" | "short">,
): PeerCandidate {
  const online: Liveness = {
    status: "online",
    phase: "active",
    pid: partial.pid ?? 1,
    since: "2026-01-01T00:00:00.000Z",
    ageMs: 0,
  }
  return {
    sid: partial.sid,
    short: partial.short,
    ...(partial.name ? { name: partial.name } : {}),
    pid: partial.pid ?? 1,
    model: partial.model ?? "m",
    cwd: partial.cwd ?? "/tmp",
    liveness: partial.liveness ?? online,
  }
}

const michelle = peer({
  sid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  short: "a1b2c3d4",
  name: "Michelle",
  pid: 11,
})
const ronald = peer({
  sid: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  short: "b2c3d4e5",
  name: "Ronald",
  pid: 22,
})
const unnamed = peer({
  sid: "c3d4e5f6-a7b8-9012-cdef-123456789012",
  short: "c3d4e5f6",
  pid: 33,
})

describe("resolveMentionPeer", () => {
  it("resolves exact name case-insensitively", () => {
    expect(resolveMentionPeer("michelle", [michelle, ronald])?.sid).toBe(michelle.sid)
  })

  it("resolves exact short sid", () => {
    expect(resolveMentionPeer("a1b2c3d4", [michelle, ronald])?.sid).toBe(michelle.sid)
  })

  it("returns null when ambiguous", () => {
    const m2 = peer({
      sid: "ffffffff-0000-0000-0000-000000000001",
      short: "ffffffff",
      name: "Michelle",
    })
    expect(resolveMentionPeer("Michelle", [michelle, m2])).toBeNull()
  })

  it("returns null for unknown", () => {
    expect(resolveMentionPeer("nobody", [michelle])).toBeNull()
  })
})

describe("rewriteMentions", () => {
  it("rewrites a unique @name to peer XML", () => {
    const out = rewriteMentions("hey @Michelle check this", [michelle, ronald])
    expect(out).toContain(
      '<ma::intercom::peer name="Michelle" sid="a1b2c3d4-e5f6-7890-abcd-ef1234567890">@Michelle</ma::intercom::peer>',
    )
    expect(out.startsWith("hey ")).toBe(true)
    expect(out.endsWith(" check this")).toBe(true)
  })

  it("leaves unmatched tokens alone", () => {
    expect(rewriteMentions("ping @nobody", [michelle])).toBe("ping @nobody")
  })

  it("rewrites multiple unique tokens", () => {
    const out = rewriteMentions("@Michelle and @Ronald", [michelle, ronald])
    expect(out).toContain('name="Michelle"')
    expect(out).toContain('name="Ronald"')
  })

  it("uses short sid when peer has no name", () => {
    const out = rewriteMentions("hi @c3d4e5f6", [unnamed])
    expect(out).toBe(
      `hi <ma::intercom::peer sid="c3d4e5f6-a7b8-9012-cdef-123456789012">@c3d4e5f6</ma::intercom::peer>`,
    )
  })

  it("is a no-op without peers or @", () => {
    expect(rewriteMentions("plain", [])).toBe("plain")
    expect(rewriteMentions("plain", [michelle])).toBe("plain")
  })
})

describe("peerXml", () => {
  it("delegates to PROMPTS with original token body", () => {
    expect(peerXml(michelle, "@Michelle")).toBe(
      '<ma::intercom::peer name="Michelle" sid="a1b2c3d4-e5f6-7890-abcd-ef1234567890">@Michelle</ma::intercom::peer>',
    )
  })
})
