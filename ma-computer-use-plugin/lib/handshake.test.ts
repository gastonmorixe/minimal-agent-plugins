/**
 * Tests of the helper protocol handshake in `ensureDaemon`: an old helper on
 * the socket is stopped (SIGTERM to the pid of its ping) and a new one starts.
 * All effects are fakes, so no daemon runs and no process gets a signal.
 *
 * @module lib/handshake.test
 */

import { describe, expect, test } from "bun:test"

import { runWithDeps } from "../handlers/computer.ts"

import {
  type EnsureDeps,
  ensureDaemon,
  HELPER_PROTOCOL,
  isCurrent,
  type PingInfo,
  parsePing,
  type SocketFetch,
} from "./client.ts"
import type { TUIContext } from "./types.ts"

/** A fake daemon world: the helper that answers, and a record of the effects. */
function world(initial: PingInfo | null) {
  const state = {
    answer: initial,
    kills: [] as Array<{ pid: number; signal: string }>,
    spawns: 0,
  }
  const deps: EnsureDeps = {
    sock: "/x.sock",
    socketExists: () => true,
    wait: async () => {},
    probe: async () => state.answer,
    spawn: () => {
      state.spawns++
      state.answer = { protocol: HELPER_PROTOCOL, pid: 222 }
    },
    kill: (pid, signal) => {
      state.kills.push({ pid, signal })
      state.answer = null
    },
    selfPid: 1000,
    attempts: 3,
    stopTimeoutMs: 500,
  }
  return { state, deps }
}

describe("parsePing and isCurrent", () => {
  test("reads protocol and pid", () => {
    expect(parsePing({ status: 200, body: { ok: true, protocol: 2, pid: 9 } })).toEqual({
      protocol: 2,
      pid: 9,
    })
  })

  test("an old ping has no protocol", () => {
    const info = parsePing({ status: 200, body: { ok: true, version: "0.1.0", pid: 9 } })
    expect(info).toEqual({ pid: 9 })
    expect(isCurrent(info ?? {})).toBe(false)
  })

  test("a status that is not 200 is no answer", () => {
    expect(parsePing({ status: 500, body: null })).toBeNull()
  })

  test("a body that is not an object gives an empty info", () => {
    expect(parsePing({ status: 200, body: null })).toEqual({})
  })

  test("protocol 2 and newer are current, 1 is old", () => {
    expect(isCurrent({ protocol: 2 })).toBe(true)
    expect(isCurrent({ protocol: 3 })).toBe(true)
    expect(isCurrent({ protocol: 1 })).toBe(false)
  })
})

describe("ensureDaemon: protocol handshake", () => {
  test("a current daemon is kept: no kill, no spawn", async () => {
    const { state, deps } = world({ protocol: 2, pid: 111 })
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.kills).toEqual([])
    expect(state.spawns).toBe(0)
  })

  test("an old daemon (no protocol) is stopped by its ping pid and replaced", async () => {
    const { state, deps } = world({ pid: 111 })
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.kills).toEqual([{ pid: 111, signal: "SIGTERM" }])
    expect(state.spawns).toBe(1)
  })

  test("an old daemon with protocol 1 is replaced", async () => {
    const { state, deps } = world({ protocol: 1, pid: 111 })
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.kills).toEqual([{ pid: 111, signal: "SIGTERM" }])
    expect(state.spawns).toBe(1)
  })

  test("no daemon: spawn with no kill", async () => {
    const { state, deps } = world(null)
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.kills).toEqual([])
    expect(state.spawns).toBe(1)
  })

  test("a kill failure gives a clear error and no spawn", async () => {
    const { state, deps } = world({ pid: 111 })
    deps.kill = () => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" })
    }
    const r = await ensureDaemon(deps)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.header).toBe("old helper")
    expect(r.error).toContain("an old computer-use helper (no protocol")
    expect(r.error).toContain("Could not stop it (pid 111): kill EPERM")
    expect(r.error).not.toContain("bun ")
    expect(r.error).not.toContain("cud ")
    expect(state.spawns).toBe(0)
  })

  test("ESRCH (the process stopped already) continues to the spawn", async () => {
    const { state, deps } = world({ pid: 111 })
    deps.kill = () => {
      state.answer = null
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
    }
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.spawns).toBe(1)
  })

  test("an old daemon that does not stop in time gives an error and no spawn", async () => {
    const { state, deps } = world({ pid: 111 })
    deps.kill = (pid, signal) => {
      state.kills.push({ pid, signal })
    }
    const r = await ensureDaemon(deps)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("did not stop in 0.5 s after SIGTERM (pid 111)")
    expect(state.spawns).toBe(0)
  })

  test("a socket file that goes away counts as stopped", async () => {
    const { state, deps } = world({ pid: 111 })
    let gone = false
    deps.socketExists = () => !gone
    deps.kill = () => {
      gone = true
    }
    deps.spawn = () => {
      state.spawns++
      gone = false
      state.answer = { protocol: 2, pid: 222 }
    }
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.spawns).toBe(1)
  })

  test("an old ping with no pid is never killed", async () => {
    const { state, deps } = world({})
    const r = await ensureDaemon(deps)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("gave no usable pid")
    expect(state.kills).toEqual([])
    expect(state.spawns).toBe(0)
  })

  test("a ping with our own pid or pid 1 is never killed", async () => {
    for (const pid of [1000, 1, 0, -5, 1.5]) {
      const { state, deps } = world({ pid })
      const r = await ensureDaemon(deps)
      expect(r.ok).toBe(false)
      expect(state.kills).toEqual([])
    }
  })

  test("a spawned helper that is old itself gives an error, not a kill loop", async () => {
    const { state, deps } = world(null)
    deps.spawn = () => {
      state.spawns++
      state.answer = { protocol: 1, pid: 333 }
    }
    const r = await ensureDaemon(deps)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("answers with protocol 1, but this plugin needs protocol 2")
    expect(state.kills).toEqual([])
  })

  test("no answer after the spawn gives the unreachable error with the log path", async () => {
    const { deps } = world(null)
    deps.spawn = () => {}
    deps.logPath = "/logs/daemon.log"
    const r = await ensureDaemon(deps)
    expect(r).toEqual({
      ok: false,
      header: "daemon unreachable",
      error:
        "the computer-use helper is not reachable and could not be started. Check the helper log: /logs/daemon.log",
    })
  })
})

/** A tool context for the handler. */
function ctx(input: Record<string, unknown>): TUIContext {
  return {
    trigger: { type: "tool", name: "Computer", input },
    packageDir: "/pkg",
    cwd: "/work",
  } as unknown as TUIContext
}

describe("runWithDeps: handshake errors", () => {
  test("the handler gives the ensure error as a tool error", async () => {
    const socketFetch: SocketFetch = async () => ({ status: 200, body: { ok: true } })
    const r = await runWithDeps(ctx({ action: "apps" }), {
      socketFetch,
      ensure: async () => ({ ok: false, header: "old helper", error: "an old helper holds it" }),
    })
    expect(r.kind).toBe("tool_result")
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    expect(r.content).toBe("Computer: an old helper holds it")
  })

  test("the handler probe parses the ping body", async () => {
    const socketFetch: SocketFetch = async () => ({
      status: 200,
      body: { ok: true, protocol: 2, pid: 42 },
    })
    const seen: { info?: PingInfo | null } = {}
    await runWithDeps(ctx({ action: "apps" }), {
      socketFetch,
      ensure: async (deps) => {
        seen.info = await deps.probe?.()
        return { ok: true }
      },
    })
    expect(seen.info).toEqual({ protocol: 2, pid: 42 })
  })

  test("a ping that throws is no answer", async () => {
    const socketFetch: SocketFetch = async () => {
      throw new Error("ECONNREFUSED")
    }
    const seen: { info?: PingInfo | null } = {}
    await runWithDeps(ctx({ action: "apps" }), {
      socketFetch,
      ensure: async (deps) => {
        seen.info = await deps.probe?.()
        return { ok: false, header: "x", error: "x" }
      },
    })
    expect(seen.info).toBeNull()
  })
})
