import { describe, expect, it } from "bun:test"

import {
  coerceTeamRef,
  isLocalTeamId,
  isSafeTeamId,
  localTeamId,
  localTeamMembers,
  normalizeTeamRef,
  teamsFromRecords,
} from "./teams.ts"

describe("isSafeTeamId", () => {
  it("accepts alnum + : _ - up to 128 chars", () => {
    expect(isSafeTeamId("local:backend")).toBe(true)
    expect(isSafeTeamId("team_42-x")).toBe(true)
    expect(isSafeTeamId("a".repeat(128))).toBe(true)
  })
  it("rejects path-traversal, framing, empty, overlong, non-strings", () => {
    expect(isSafeTeamId("../etc/passwd")).toBe(false)
    expect(isSafeTeamId("a/b")).toBe(false)
    expect(isSafeTeamId("<ma::x>")).toBe(false)
    expect(isSafeTeamId("")).toBe(false)
    expect(isSafeTeamId("a".repeat(129))).toBe(false)
    expect(isSafeTeamId(42)).toBe(false)
    expect(isSafeTeamId(null)).toBe(false)
  })
})

describe("localTeamId + namespace", () => {
  it("builds a sanitized local: id from a slug", () => {
    expect(localTeamId("Backend Team!")).toBe("local:backend-team")
    expect(localTeamId("  weird  ")).toBe("local:weird")
    expect(localTeamId("")).toBe("local:team")
  })
  it("isLocalTeamId detects the namespace", () => {
    expect(isLocalTeamId("local:x")).toBe(true)
    expect(isLocalTeamId("backend-uuid")).toBe(false)
  })
})

describe("normalizeTeamRef", () => {
  it("strips a leading team: scope (case-insensitive keyword) and trims, preserving id case", () => {
    expect(normalizeTeamRef("team:local:backend")).toBe("local:backend")
    // the `team:` scope keyword is matched case-insensitively, but the id body
    // is preserved verbatim (team ids are case-sensitive identifiers).
    expect(normalizeTeamRef("  TEAM:Backend-X  ")).toBe("Backend-X")
    expect(normalizeTeamRef("local:backend")).toBe("local:backend")
    expect(normalizeTeamRef("")).toBe("")
  })
})

describe("coerceTeamRef", () => {
  it("coerces a valid object, defaulting name+remote", () => {
    const t = coerceTeamRef({ id: "local:backend" })
    expect(t).not.toBeNull()
    expect(t?.id).toBe("local:backend")
    expect(t?.name).toBe("local:backend") // name defaults to id
    expect(t?.computerId).toBeNull()
    expect(t?.remote).toBe(false) // local: namespace ⇒ local
  })
  it("a backend (non-local) id defaults remote=true", () => {
    expect(coerceTeamRef({ id: "be-uuid-123" })?.remote).toBe(true)
  })
  it("honors an explicit remote flag + computerId + name", () => {
    const t = coerceTeamRef({ id: "local:x", name: "X Team", computerId: "c1", remote: true })
    expect(t?.remote).toBe(true)
    expect(t?.computerId).toBe("c1")
    expect(t?.name).toBe("X Team")
  })
  it("rejects an unsafe id", () => {
    expect(coerceTeamRef({ id: "../x" })).toBeNull()
    expect(coerceTeamRef(null)).toBeNull()
  })
})

describe("localTeamMembers + teamsFromRecords", () => {
  const recs = [
    { sid: "a", teams: ["local:backend", "local:web"] },
    { sid: "b", teams: ["local:backend"] },
    { sid: "c" }, // teamless
    { sid: "d", teams: ["local:web"] },
  ]
  it("localTeamMembers filters by membership", () => {
    expect(localTeamMembers(recs, "local:backend").map((r) => r.sid)).toEqual(["a", "b"])
    expect(localTeamMembers(recs, "local:web").map((r) => r.sid)).toEqual(["a", "d"])
    expect(localTeamMembers(recs, "local:none")).toEqual([])
  })
  it("teamsFromRecords lists distinct safe team ids", () => {
    expect(teamsFromRecords(recs).sort()).toEqual(["local:backend", "local:web"])
  })
})
