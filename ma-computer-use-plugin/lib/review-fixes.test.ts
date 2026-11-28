/**
 * Tests of the plugins review fixes (H1, H2, H3, M1, M2). All daemon effects
 * are fakes: no daemon runs and no process gets a signal. The lock tests and
 * the real-table test use temp folders from `os.tmpdir()`.
 *
 * @module lib/review-fixes.test
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  clearEmbeddedPlugins,
  type EmbeddedPluginTable,
  pruneEmbeddedCache,
  registerEmbeddedPlugins,
} from "@minimal-agent/core/host-kit/embedded-plugins"

import { type HandlerDeps, runWithDeps } from "../handlers/computer.ts"

import {
  ABSENT,
  binaryKeyOf,
  type EnsureDeps,
  ensureDaemon,
  HELPER_PROTOCOL,
  HelperTimeoutError,
  type PingInfo,
  type ProbeResult,
  probePing,
  type SocketFetch,
  TIMEOUT,
} from "./client.ts"
import { embeddedHelperFor, extractHelper, HELPER_KEY, isCompiledHost } from "./embedded-helper.ts"
import { GRANT_HINT, missingHelperText, REBUILD_HINT } from "./missing-helper.ts"
import { isLockStale, tryAcquireLock } from "./spawn-lock.ts"
import type { TUIContext } from "./types.ts"

let dir = ""
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cu-review-fixes-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A fake helper world with a record of the effects. */
function world(answer: ProbeResult) {
  const state = { answer, kills: [] as number[], spawns: 0 }
  const deps: EnsureDeps = {
    sock: "/x.sock",
    socketExists: () => true,
    wait: async () => {},
    probe: async () => state.answer,
    spawn: () => {
      state.spawns++
      state.answer = { kind: "answer", info: { protocol: HELPER_PROTOCOL, pid: 222 } }
    },
    kill: (pid) => {
      state.kills.push(pid)
      state.answer = ABSENT
    },
    selfPid: 1000,
    attempts: 3,
    stopTimeoutMs: 500,
  }
  return { state, deps }
}

describe("H1: probePing gives 3 kinds", () => {
  test("an answer, a timeout, and ECONNREFUSED / ENOENT / a bad status", async () => {
    const ok: SocketFetch = async () => ({ status: 200, body: { protocol: 2, pid: 5 } })
    expect(await probePing(ok)).toEqual({ kind: "answer", info: { protocol: 2, pid: 5 } })
    const slow: SocketFetch = async (route) => {
      throw new HelperTimeoutError(route, 2000)
    }
    expect(await probePing(slow)).toEqual(TIMEOUT)
    for (const code of ["ECONNREFUSED", "ENOENT"]) {
      const refused: SocketFetch = async () => {
        throw Object.assign(new TypeError(code), { code })
      }
      expect(await probePing(refused)).toEqual(ABSENT)
    }
    const bad: SocketFetch = async () => ({ status: 500, body: null })
    expect(await probePing(bad)).toEqual(ABSENT)
  })
})

describe("H1 / M2: a busy helper is not replaced", () => {
  test("ping timeout with the socket present: busy error, no spawn, no kill", async () => {
    const { state, deps } = world(TIMEOUT)
    deps.logPath = "/logs/daemon.log"
    const r = await ensureDaemon(deps)
    expect(r).toEqual({
      ok: false,
      header: "helper busy",
      error:
        "the computer-use helper is busy with another request, try again. If it repeats, check the helper log: /logs/daemon.log",
    })
    expect(state.spawns).toBe(0)
    expect(state.kills).toEqual([])
  })

  test("the handler gives the busy error as a tool error", async () => {
    const socketFetch: SocketFetch = async (route) => {
      throw new HelperTimeoutError(route, 2000)
    }
    const spawned: string[] = []
    const r = await runWithDeps(ctx("/pkg"), {
      socketFetch,
      extract: () => ({ ok: true, path: "/pkg/native/build/ComputerUseHelper" }),
      spawnDaemon: (bin) => spawned.push(bin),
      ensure: (d) => ensureDaemon({ ...d, socketExists: () => true, lockPath: undefined }),
    })
    expect(r.kind).toBe("tool_result")
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    expect(r.content).toStartWith(
      "Computer: the computer-use helper is busy with another request, try again.",
    )
    expect(spawned).toEqual([])
  })

  test("a timeout during the stop wait does not count as stopped", async () => {
    const { state, deps } = world({ kind: "answer", info: { pid: 111 } })
    deps.kill = (pid) => {
      state.kills.push(pid)
      state.answer = TIMEOUT
    }
    deps.pingTimeoutMs = 200
    const r = await ensureDaemon(deps)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("did not stop")
    expect(state.spawns).toBe(0)
  })
})

describe("H1: spawn lock", () => {
  test("two parallel calls with no helper spawn once, and the lock is gone after", async () => {
    let spawns = 0
    let upAt = Number.POSITIVE_INFINITY
    const lockPath = join(dir, "support", "cud.sock.spawn.lock")
    const deps: EnsureDeps = {
      sock: join(dir, "cud.sock"),
      lockPath,
      socketExists: () => true,
      probe: async () =>
        Date.now() >= upAt ? { kind: "answer", info: { protocol: HELPER_PROTOCOL } } : ABSENT,
      spawn: () => {
        spawns++
        upAt = Date.now() + 60
      },
      wait: (ms) => new Promise((r) => setTimeout(r, ms / 10)),
      attempts: 40,
    }
    const [a, b] = await Promise.all([ensureDaemon(deps), ensureDaemon(deps)])
    expect([a, b]).toEqual([{ ok: true }, { ok: true }])
    expect(spawns).toBe(1)
    expect(existsSync(lockPath)).toBe(false)
  })

  test("a stale lock (dead pid) does not block the spawn", async () => {
    const lockPath = join(dir, "cud.sock.spawn.lock")
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, time: Date.now() }))
    const { state, deps } = world(ABSENT)
    deps.lockPath = lockPath
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.spawns).toBe(1)
    expect(existsSync(lockPath)).toBe(false)
  })

  test("a live lock blocks a second take, then frees", () => {
    const p = join(dir, "x.lock")
    const r1 = tryAcquireLock(p)
    expect(r1).toBeDefined()
    expect(tryAcquireLock(p)).toBeUndefined()
    expect(JSON.parse(readFileSync(p, "utf8")).pid).toBe(process.pid)
    r1?.()
    expect(existsSync(p)).toBe(false)
  })

  test("an old lock of a live pid is stale", () => {
    const p = join(dir, "old.lock")
    writeFileSync(p, JSON.stringify({ pid: process.pid, time: 0 }))
    expect(isLockStale(p, 10_000, 20_000)).toBe(true)
    expect(isLockStale(p, 10_000, 5_000)).toBe(false)
  })

  test("the lock makes a missing parent dir", () => {
    const p = join(dir, "no", "such", "dir", "a.lock")
    const r = tryAcquireLock(p)
    expect(existsSync(p)).toBe(true)
    r?.()
    expect(existsSync(p)).toBe(false)
  })

  test("the handler passes a lock path next to the socket", async () => {
    const seen: { lock?: string } = {}
    await runWithDeps(ctx("/pkg"), {
      socketFetch: async () => ({ status: 200, body: {} }),
      extract: () => ({ ok: true, path: "/x" }),
      ensure: async (d) => {
        seen.lock = d.lockPath
        return { ok: true }
      },
    })
    expect(seen.lock?.endsWith(".sock.spawn.lock")).toBe(true)
  })
})

describe("H3 / M2: an old spawned helper is not killed again", () => {
  test("2 calls in sequence: one kill, then a clear error with no second kill", async () => {
    const old: PingInfo = { pid: 111 }
    const { state, deps } = world({ kind: "answer", info: old })
    let nextPid = 201
    deps.spawn = () => {
      state.spawns++
      state.answer = { kind: "answer", info: { pid: nextPid++ } }
    }
    deps.binaryKey = "/pkg/native/build/ComputerUseHelper:10:1"
    deps.oldBinaries = new Set()
    deps.oldBinaryHint = REBUILD_HINT
    const r1 = await ensureDaemon(deps)
    const r2 = await ensureDaemon(deps)
    expect(state.kills).toEqual([111])
    expect(state.spawns).toBe(1)
    for (const r of [r1, r2]) {
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.header).toBe("old helper")
      expect(r.error).toContain("The helper binary is older than the plugin.")
      expect(r.error).toEndWith(REBUILD_HINT)
    }
  })

  test("a rebuilt binary (new key) is tried again", async () => {
    const { state, deps } = world({ kind: "answer", info: { pid: 111 } })
    deps.oldBinaries = new Set(["/b:1:1"])
    deps.binaryKey = "/b:2:2"
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.kills).toEqual([111])
  })

  test("binaryKeyOf: path, size, mtime, and undefined for a missing file", () => {
    expect(binaryKeyOf("/b", () => ({ size: 3, mtimeMs: 7 }))).toBe("/b:3:7")
    expect(binaryKeyOf(join(dir, "missing"))).toBeUndefined()
  })

  test("a dev checkout with only the legacy .app gets the build text and no ensure", async () => {
    const pkg = join(dir, "ma-computer-use-plugin")
    mkdirSync(join(pkg, "native", "Sources"), { recursive: true })
    const macos = join(pkg, "native", "build", "ComputerUseHelper.app", "Contents", "MacOS")
    mkdirSync(macos, { recursive: true })
    writeFileSync(join(macos, "ComputerUseHelper"), "")
    const calls: string[] = []
    const saved = process.env.CUD_HELPER
    delete process.env.CUD_HELPER
    try {
      const r = await runWithDeps(ctx(pkg), {
        extract: (d) => extractHelper(d, { env: {}, cache: new Map() }),
        compiledHost: () => false,
        ensure: async () => {
          calls.push("ensure")
          return { ok: true }
        },
      })
      expect(calls).toEqual([])
      expect(r.kind).toBe("tool_result")
      if (r.kind !== "tool_result") return
      expect(r.content).toBe(missingHelperText(join(pkg, HELPER_KEY), true))
      expect(r.content).toContain("bun run bin/cud.ts build")
    } finally {
      if (saved !== undefined) process.env.CUD_HELPER = saved
    }
  })
})

/** A tool context for the handler. */
function ctx(packageDir: string): TUIContext {
  return {
    trigger: { type: "tool", name: "Computer", input: { action: "apps" } },
    packageDir,
    cwd: "/work",
  } as unknown as TUIContext
}

describe("H2 / M2: a compiled host never gets the dev text", () => {
  test("a source run (no table registered) is not a compiled host", () => {
    expect(isCompiledHost()).toBe(false)
  })

  test("package dir with native/Sources and a compiled host: release text", async () => {
    const pkg = join(dir, "user-tier", "ma-computer-use-plugin")
    mkdirSync(join(pkg, "native", "Sources"), { recursive: true })
    const deps: HandlerDeps = {
      extract: () => ({ ok: true, path: join(pkg, HELPER_KEY) }),
      compiledHost: () => true,
      ensure: async () => ({ ok: true }),
    }
    const r = await runWithDeps(ctx(pkg), deps)
    expect(r.kind).toBe("tool_result")
    if (r.kind !== "tool_result") return
    expect(r.content).toBe(missingHelperText(join(pkg, HELPER_KEY), false))
    expect(r.displayHeader).toContain("helper not included")
    for (const word of ["bun", "cud.ts", "swiftc"]) expect(r.content).not.toContain(word)
  })

  test("the old-binary hint of a compiled host is the release text", async () => {
    const pkg = join(dir, "ma-computer-use-plugin")
    mkdirSync(join(pkg, "native", "Sources"), { recursive: true })
    const seen: { hint?: string } = {}
    await runWithDeps(ctx(pkg), {
      socketFetch: async () => ({ status: 200, body: {} }),
      extract: () => ({ ok: true, path: "/x" }),
      compiledHost: () => true,
      ensure: async (d) => {
        seen.hint = d.oldBinaryHint
        return { ok: true }
      },
    })
    expect(seen.hint).toBe("Install a release where the two agree.")
  })

  test("a user-tier disk copy uses the helper of the embedded package of the same name", async () => {
    const root = join(dir, "host")
    const src = join(root, "helper-source")
    mkdirSync(root, { recursive: true })
    writeFileSync(src, "#!/bin/sh\nexit 0\n")
    const table: EmbeddedPluginTable = {
      buildId: "review-build-1",
      packages: {
        "ma-computer-use-plugin": {
          texts: { "manifest.json": '{"id":"computer-use"}' },
          modules: {},
          files: { [HELPER_KEY]: src },
        },
      },
    }
    const cacheRoot = join(root, "cache")
    const userPkg = join(root, "user", "ma-computer-use-plugin")
    mkdirSync(join(userPkg, "native", "Sources"), { recursive: true })
    registerEmbeddedPlugins(table, { cacheRoot })
    try {
      expect(isCompiledHost()).toBe(true)
      const want = join(cacheRoot, "review-build-1", "ma-computer-use-plugin", HELPER_KEY)
      expect(embeddedHelperFor(userPkg)).toBe(want)
      const r = extractHelper(userPkg, { env: {}, cache: new Map() })
      expect(r).toEqual({ ok: true, path: want })
      expect(readFileSync(want, "utf8")).toBe("#!/bin/sh\nexit 0\n")
      // An embedded package dir is not its own twin.
      expect(embeddedHelperFor(join(cacheRoot, "review-build-1", "ma-computer-use-plugin"))).toBe(
        undefined,
      )
    } finally {
      pruneEmbeddedCache()
      clearEmbeddedPlugins()
    }
    expect(embeddedHelperFor(userPkg)).toBeUndefined()
  })

  test("a disk package with its own built helper keeps it", () => {
    const r = extractHelper("/pkg", {
      env: {},
      cache: new Map(),
      execPath: (d, rel) => `${d}/${rel}`,
      exists: () => true,
      embeddedFallback: () => "/never",
    })
    expect(r).toEqual({ ok: true, path: "/pkg/native/build/ComputerUseHelper" })
  })
})

describe("M1 / L3: one grant text in TS and Swift", () => {
  test("GRANT_HINT names both grants and the restart of the terminal app", () => {
    expect(GRANT_HINT).toContain("Accessibility and Screen Recording")
    expect(GRANT_HINT).toContain("Then quit the terminal app, open it again, and try again.")
  })

  test("Permissions.swift grantHint is the same text", () => {
    const swift = readFileSync(
      join(import.meta.dir, "..", "native", "Sources", "Permissions.swift"),
      "utf8",
    )
    const m = /static let grantHint =\s*((?:"[^"]*"\s*\+?\s*)+)/.exec(swift)
    expect(m).not.toBeNull()
    const text = [...(m?.[1] ?? "").matchAll(/"([^"]*)"/g)].map((x) => x[1]).join("")
    expect(text).toBe(GRANT_HINT)
  })
})
