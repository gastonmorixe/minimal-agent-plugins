/**
 * Backward-compatibility proof for the Teams additions: a presence record with
 * NO teams and NO computerId must serialize byte-identically to pre-Teams
 * Intercom, so a Teams-aware session and an old session stay interoperable on
 * the same on-disk files. Plus machine-id behavior.
 *
 * @module lib/teams-compat.test
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { buildSelfPresenceRecord } from "./beat.ts"
import type { SelfIdentity } from "./identity.ts"
import { __resetMachineIdCacheForTests, machineId, machineIdPath } from "./machine-id.ts"
import { coercePresence, type PresenceRecord, writePresence } from "./presence.ts"

afterEach(() => __resetMachineIdCacheForTests())

function tmpHome(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "intercom-teams-"))
  return {
    env: { MINIMAL_AGENT_HOME: dir },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const PRE_TEAMS_REC: PresenceRecord = {
  v: 1,
  sid: "aaaaaaaa-1",
  short: "aaaaaaaa",
  pid: 7,
  host: "h",
  ts: "2026-06-24T00:00:00.000Z",
  startedAt: "2026-06-24T00:00:00.000Z",
  agentVersion: "0.1.0",
  model: "m",
  cwd: "/c",
  projectRoot: "/c",
  phase: "active",
  activity: null,
}

describe("Teams wire-format backward compatibility", () => {
  it("a teamless + computerId-less record serializes with NO new keys", () => {
    const json = JSON.stringify(PRE_TEAMS_REC)
    expect(json).not.toContain("teams")
    expect(json).not.toContain("computerId")
  })

  it("coercePresence round-trips a teamless record to the IDENTICAL object (no teams/computerId)", () => {
    const back = coercePresence(JSON.parse(JSON.stringify(PRE_TEAMS_REC)))
    expect(back).toEqual(PRE_TEAMS_REC)
    expect("teams" in (back as object)).toBe(false)
    expect("computerId" in (back as object)).toBe(false)
  })

  it("an old reader (which ignores unknown keys) still parses a Teams-era record's core fields", () => {
    const teamsEra = { ...PRE_TEAMS_REC, computerId: "c-123", teams: ["local:backend"] }
    const back = coercePresence(teamsEra)
    expect(back?.sid).toBe("aaaaaaaa-1")
    expect(back?.computerId).toBe("c-123")
    expect(back?.teams).toEqual(["local:backend"])
  })

  it("buildSelfPresenceRecord omits teams when the session has none (byte-identical core)", () => {
    const self: SelfIdentity = {
      sid: "aaaaaaaa-1",
      short: "aaaaaaaa",
      pid: 7,
      host: "h",
      model: "m",
      agentVersion: "0.1.0",
      computerId: "", // empty ⇒ omitted, simulating a no-computerId build
    }
    const rec = buildSelfPresenceRecord(
      self,
      { phase: "active", activity: null, cwd: "/c", projectRoot: "/c" },
      "2026-06-24T00:00:00.000Z",
      "2026-06-24T00:00:00.000Z",
    )
    const json = JSON.stringify(rec)
    expect(json).not.toContain("teams")
    expect(json).not.toContain("computerId")
  })

  it("buildSelfPresenceRecord includes teams + computerId when present", () => {
    const self: SelfIdentity = {
      sid: "aaaaaaaa-1",
      short: "aaaaaaaa",
      pid: 7,
      host: "h",
      model: "m",
      agentVersion: "0.1.0",
      computerId: "c-123",
    }
    const rec = buildSelfPresenceRecord(
      self,
      { phase: "active", activity: null, cwd: "/c", projectRoot: "/c", teams: ["local:backend"] },
      "2026-06-24T00:00:00.000Z",
      "2026-06-24T00:00:00.000Z",
    )
    expect(rec.computerId).toBe("c-123")
    expect(rec.teams).toEqual(["local:backend"])
  })

  it("coercePresence caps + sanitizes a hostile teams array", () => {
    const hostile = {
      ...PRE_TEAMS_REC,
      teams: ["local:ok", "../escape", 42, "local:ok", "<ma::x>", "a".repeat(200)],
    }
    const back = coercePresence(hostile)
    expect(back?.teams).toEqual(["local:ok"]) // dup + unsafe + overlong dropped
  })
})

describe("machineId (computerId source — Steve ruling 1)", () => {
  it("mints + persists a uuid once, reuses it on the next read", () => {
    const h = tmpHome()
    try {
      __resetMachineIdCacheForTests()
      const first = machineId(h.env, () => "11111111-2222-3333-4444-555555555555")
      // file now exists; a second call with a DIFFERENT generator must reuse the
      // persisted value, not mint a new one.
      __resetMachineIdCacheForTests()
      const second = machineId(h.env, () => "99999999-9999-9999-9999-999999999999")
      expect(first).toBe("11111111-2222-3333-4444-555555555555")
      expect(second).toBe(first)
      expect(readFileSync(machineIdPath(h.env), "utf-8").trim()).toBe(first)
    } finally {
      h.cleanup()
    }
  })

  it("is NOT the hostname (a real uuid)", () => {
    const h = tmpHome()
    try {
      __resetMachineIdCacheForTests()
      const id = machineId(h.env)
      expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    } finally {
      h.cleanup()
    }
  })

  it("ignores a corrupt machine-id file and re-mints", () => {
    const h = tmpHome()
    try {
      __resetMachineIdCacheForTests()
      // write a garbage file
      writePresence(machineIdPath(h.env), PRE_TEAMS_REC) // writes JSON, not a valid id
      __resetMachineIdCacheForTests()
      const id = machineId(h.env, () => "22222222-2222-2222-2222-222222222222")
      expect(id).toBe("22222222-2222-2222-2222-222222222222")
    } finally {
      h.cleanup()
    }
  })
})
