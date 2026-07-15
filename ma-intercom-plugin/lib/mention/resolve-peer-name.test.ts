/**
 * resolvePeer name matching — service-layer integration via a fake roster.
 *
 * We don't hit disk: we stub loadRoster by constructing ServiceDeps-like
 * state isn't easy without fs, so we unit-test the name path by importing
 * the pure helpers and by exercising resolvePeer with a temp presence dir.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { resolvePeer, type ServiceDeps } from "../service.ts"

const TMP = join(tmpdir(), `intercom-mention-resolve-${process.pid}`)

function writePresence(sid: string, name?: string): void {
  const rec = {
    v: 1,
    sid,
    short: sid.slice(0, 8),
    pid: 4242,
    host: "testhost",
    ts: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    agentVersion: "0.1.0",
    model: "test-model",
    cwd: "/tmp",
    projectRoot: "/tmp",
    phase: "active",
    activity: null,
    ...(name ? { name } : {}),
  }
  writeFileSync(join(TMP, "intercom", "presence", `${sid}.json`), JSON.stringify(rec))
}

function mkDeps(selfSid: string): ServiceDeps {
  return {
    env: {
      MINIMAL_AGENT_HOME: TMP,
    } as NodeJS.ProcessEnv,
    self: {
      sid: selfSid,
      short: selfSid.slice(0, 8),
      pid: 1,
      host: "testhost",
      model: "m",
      agentVersion: "v",
      computerId: "cid",
    },
    thresholds: { heartbeatMs: 5_000, freshMs: 15_000, staleMs: 60_000 },
    now: () => Date.now(),
    host: "testhost",
    pidAlive: () => true,
  }
}

describe("resolvePeer — name matching", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(join(TMP, "intercom", "presence"), { recursive: true })
    writePresence("a1b2c3d4-1111-4000-8000-000000000001", "Michelle")
    writePresence("b2c3d4e5-2222-4000-8000-000000000002", "Ronald")
    writePresence("self0000-0000-4000-8000-000000000099", "Me")
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it("resolves by exact name (case-insensitive)", () => {
    const deps = mkDeps("self0000-0000-4000-8000-000000000099")
    const r = resolvePeer(deps, "michelle")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.row.record.name).toBe("Michelle")
  })

  it("resolves by name prefix when unique", () => {
    const deps = mkDeps("self0000-0000-4000-8000-000000000099")
    const r = resolvePeer(deps, "Ron")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.row.record.name).toBe("Ronald")
  })

  it("still resolves by short sid", () => {
    const deps = mkDeps("self0000-0000-4000-8000-000000000099")
    const r = resolvePeer(deps, "a1b2c3d4")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.row.record.name).toBe("Michelle")
  })

  it("returns ambiguous when name prefix hits multiple", () => {
    writePresence("c3d4e5f6-3333-4000-8000-000000000003", "Mickey")
    const deps = mkDeps("self0000-0000-4000-8000-000000000099")
    const r = resolvePeer(deps, "Mic")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("ambiguous")
  })

  it("returns self when ref is own name", () => {
    const deps = mkDeps("self0000-0000-4000-8000-000000000099")
    const r = resolvePeer(deps, "Me")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("self")
  })
})
