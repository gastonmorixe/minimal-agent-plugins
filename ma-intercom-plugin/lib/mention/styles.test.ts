import { describe, expect, it } from "bun:test"

import type { Liveness } from "../liveness.ts"

import { mentionStyleSpans } from "./styles.ts"
import type { PeerCandidate } from "./types.ts"

const online: Liveness = {
  status: "online",
  phase: "active",
  pid: 1,
  since: "2026-01-01T00:00:00.000Z",
  ageMs: 0,
}

const michelle: PeerCandidate = {
  sid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  short: "a1b2c3d4",
  name: "Michelle",
  pid: 1,
  model: "m",
  cwd: "/tmp",
  liveness: online,
}

describe("mentionStyleSpans", () => {
  it("returns empty when no peers or no text", () => {
    expect(mentionStyleSpans("", [michelle])).toEqual([])
    expect(mentionStyleSpans("@Michelle", [])).toEqual([])
  })

  it("spans a matching @name with style field (not sgr)", () => {
    const spans = mentionStyleSpans("hey @Michelle ok", [michelle], "\x1b[1;35m")
    expect(spans).toHaveLength(1)
    expect(spans[0]).toEqual({ start: 4, end: 13, style: "\x1b[1;35m" })
    // "hey " = 4; "@Michelle" = 9 chars → end 13
  })

  it("does not style unmatched tokens", () => {
    expect(mentionStyleSpans("hey @nobody", [michelle])).toEqual([])
  })

  it("highlights a lone @ when peers exist", () => {
    const spans = mentionStyleSpans("say @", [michelle], "V")
    expect(spans).toEqual([{ start: 4, end: 5, style: "V" }])
  })
})
