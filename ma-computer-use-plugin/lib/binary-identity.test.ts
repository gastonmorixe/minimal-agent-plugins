/**
 * Tests of review M3: a protocol-2 helper from another build holds the socket.
 * The helper `ping` gives the identity of its own binary file (resolved path,
 * size, mtime). `ensureDaemon` compares it with the binary that it would
 * start, and replaces a helper that differs or gives no identity. All daemon
 * effects are fakes: no daemon runs and no process gets a signal.
 *
 * @module lib/binary-identity.test
 */

import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { runWithDeps } from "../handlers/computer.ts"

import {
  ABSENT,
  type BinaryIdentity,
  binaryIdentityOf,
  type EnsureDeps,
  ensureDaemon,
  HELPER_PROTOCOL,
  judgePing,
  MTIME_TOLERANCE_S,
  type PingInfo,
  parsePing,
} from "./client.ts"
import { extractHelper } from "./embedded-helper.ts"
import type { TUIContext } from "./types.ts"

/** The binary that the fake handler would start. */
const BIN: BinaryIdentity = {
  path: "/pkg/native/build/ComputerUseHelper",
  size: 1000,
  mtime: 1_790_000_000.25,
}

/** The same file one second later (a rebuild, an extract, or a `touch`). */
const NEWER: BinaryIdentity = { ...BIN, mtime: BIN.mtime + 1 }

/**
 * A fake helper world. `answer` is the helper on the socket (null: none).
 * A spawn starts a helper that gives `spawned`.
 */
function world(answer: PingInfo | null, spawned: PingInfo) {
  const state = {
    answer,
    kills: [] as Array<{ pid: number; signal: string }>,
    spawns: 0,
  }
  const deps: EnsureDeps = {
    sock: "/x.sock",
    socketExists: () => true,
    wait: async () => {},
    probe: async () => (state.answer === null ? ABSENT : { kind: "answer", info: state.answer }),
    spawn: () => {
      state.spawns++
      state.answer = spawned
    },
    kill: (pid, signal) => {
      state.kills.push({ pid, signal })
      state.answer = null
    },
    selfPid: 1000,
    attempts: 3,
    stopTimeoutMs: 500,
    binary: BIN,
    oldBinaries: new Set(),
  }
  return { state, deps }
}

/** A current helper (protocol 2) that started from `binary`. */
function helper(pid: number, binary?: BinaryIdentity): PingInfo {
  return binary === undefined
    ? { protocol: HELPER_PROTOCOL, pid }
    : { protocol: HELPER_PROTOCOL, pid, binary }
}

describe("M3: ensureDaemon compares the binary identity", () => {
  test("the same binary is kept: no kill, no spawn", async () => {
    const { state, deps } = world(helper(111, BIN), helper(222, BIN))
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.kills).toEqual([])
    expect(state.spawns).toBe(0)
  })

  test("a different mtime is another build: SIGTERM to the ping pid, then one spawn", async () => {
    const { state, deps } = world(helper(111, BIN), helper(222, NEWER))
    deps.binary = NEWER
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.kills).toEqual([{ pid: 111, signal: "SIGTERM" }])
    expect(state.spawns).toBe(1)
  })

  test("the same path with another size, or a later mtime, is another build", async () => {
    for (const other of [
      { ...BIN, size: BIN.size + 1 },
      { ...BIN, mtime: BIN.mtime + 60 },
    ]) {
      const { state, deps } = world(helper(111, other), helper(222, BIN))
      expect(await ensureDaemon(deps)).toEqual({ ok: true })
      expect(state.kills).toEqual([{ pid: 111, signal: "SIGTERM" }])
      expect(state.spawns).toBe(1)
    }
  })

  test("another path with an older mtime is replaced", async () => {
    const other = { ...BIN, path: "/old/native/build/ComputerUseHelper", mtime: BIN.mtime - 60 }
    const { state, deps } = world(helper(111, other), helper(222, BIN))
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.kills).toEqual([{ pid: 111, signal: "SIGTERM" }])
    expect(state.spawns).toBe(1)
  })

  test("another path with the same or a newer mtime is kept (no ping-pong of 2 checkouts)", async () => {
    for (const mtime of [BIN.mtime, BIN.mtime + 60]) {
      const other = { ...BIN, path: "/other/native/build/ComputerUseHelper", mtime }
      const { state, deps } = world(helper(111, other), helper(222, BIN))
      expect(await ensureDaemon(deps)).toEqual({ ok: true })
      expect(state.kills).toEqual([])
      expect(state.spawns).toBe(0)
    }
  })

  test("a mtime difference under the tolerance is the same file", async () => {
    const near = { ...BIN, mtime: BIN.mtime + MTIME_TOLERANCE_S / 10 }
    const { state, deps } = world(helper(111, near), helper(222, BIN))
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.kills).toEqual([])
  })

  test("a protocol-2 ping with no binary field is an older build and is replaced", async () => {
    const { state, deps } = world(helper(111), helper(222, BIN))
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.kills).toEqual([{ pid: 111, signal: "SIGTERM" }])
    expect(state.spawns).toBe(1)
  })

  test("the stop error names the two binaries, not the protocol", async () => {
    const { state, deps } = world(helper(111, BIN), helper(222, NEWER))
    deps.binary = NEWER
    deps.kill = (pid, signal) => {
      state.kills.push({ pid, signal })
    }
    const r = await ensureDaemon(deps)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.header).toBe("old helper")
    expect(r.error).toContain("a computer-use helper from another build")
    expect(r.error).toContain(`${BIN.path} (1000 bytes, mtime ${BIN.mtime})`)
    expect(r.error).toContain(`this plugin starts ${NEWER.path} (1000 bytes, mtime ${NEWER.mtime})`)
    expect(r.error).toContain("did not stop in 0.5 s after SIGTERM (pid 111)")
    expect(r.error).not.toContain("needs protocol")
    expect(state.spawns).toBe(0)
  })

  test("no kill loop: a spawned helper that still differs gives a clear error, one kill in 2 calls", async () => {
    let nextPid = 201
    const { state, deps } = world(helper(111), helper(0))
    deps.spawn = () => {
      state.spawns++
      state.answer = helper(nextPid++, { ...BIN, mtime: 5 })
    }
    const r1 = await ensureDaemon(deps)
    const r2 = await ensureDaemon(deps)
    expect(state.kills).toEqual([{ pid: 111, signal: "SIGTERM" }])
    expect(state.spawns).toBe(1)
    for (const r of [r1, r2]) {
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.header).toBe("old helper")
      expect(r.error).toContain("does not give the binary that this plugin starts")
      expect(r.error).toContain(`expected ${BIN.path} (1000 bytes, mtime ${BIN.mtime})`)
      expect(r.error).toContain("Quit the ComputerUseHelper process (Activity Monitor)")
      expect(r.error).not.toContain("needs protocol")
    }
  })

  test("a changed binary (new identity) is tried again after a mismatch", async () => {
    let nextPid = 201
    const { state, deps } = world(helper(111), helper(0))
    deps.spawn = () => {
      state.spawns++
      state.answer = helper(nextPid++, { ...BIN, mtime: 5 })
    }
    expect((await ensureDaemon(deps)).ok).toBe(false)
    deps.binary = NEWER
    deps.spawn = () => {
      state.spawns++
      state.answer = helper(nextPid++, NEWER)
    }
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.kills.map((k) => k.pid)).toEqual([111, 201])
    expect(state.spawns).toBe(2)
  })

  test("with no binary to compare (the file cannot be read), only the protocol counts", async () => {
    const { state, deps } = world(helper(111), helper(222))
    delete deps.binary
    expect(await ensureDaemon(deps)).toEqual({ ok: true })
    expect(state.kills).toEqual([])
    expect(state.spawns).toBe(0)
  })

  test("an old protocol still gives the protocol text", async () => {
    const { state, deps } = world({ protocol: 1, pid: 111, binary: BIN }, helper(222, BIN))
    deps.kill = () => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" })
    }
    const r = await ensureDaemon(deps)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain(
      "an old computer-use helper (protocol 1, this plugin needs protocol 2)",
    )
    expect(state.spawns).toBe(0)
  })

  test("a helper with no identity after the spawn gives the rebuild hint, no second kill", async () => {
    let nextPid = 201
    const { state, deps } = world(helper(111), helper(0))
    deps.binary = NEWER
    deps.spawn = () => {
      state.spawns++
      state.answer = helper(nextPid++)
    }
    deps.oldBinaryHint = "Build the helper again."
    const r1 = await ensureDaemon(deps)
    const r2 = await ensureDaemon(deps)
    expect(state.kills.map((k) => k.pid)).toEqual([111])
    for (const r of [r1, r2]) {
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.error).toBe(
        "the computer-use helper gives no binary identity in its ping. The helper binary is older than the plugin. Build the helper again.",
      )
    }
  })
})

describe("M3: judgePing", () => {
  test("the verdict of each case", () => {
    expect(judgePing({ protocol: 1, binary: BIN }, 2, BIN)).toBe("protocol")
    expect(judgePing({ protocol: 2 }, 2, BIN)).toBe("no-identity")
    expect(judgePing({ protocol: 2 }, 2)).toBe("ok")
    expect(judgePing({ protocol: 2, binary: BIN }, 2, BIN)).toBe("ok")
    expect(judgePing({ protocol: 2, binary: BIN }, 2, NEWER)).toBe("other-build")
    expect(judgePing({ protocol: 3, binary: NEWER }, 2, BIN)).toBe("other-build")
  })
})

describe("M3: parsePing reads the binary field", () => {
  test("a full field is read", () => {
    const body = { ok: true, protocol: 2, pid: 9, binary: { ...BIN, extra: 1 } }
    expect(parsePing({ status: 200, body })).toEqual({ protocol: 2, pid: 9, binary: BIN })
  })

  test("a field with a missing or wrong part is ignored", () => {
    for (const binary of [null, "x", { path: "/a", size: 1 }, { path: 1, size: 1, mtime: 1 }]) {
      expect(parsePing({ status: 200, body: { protocol: 2, pid: 9, binary } })).toEqual({
        protocol: 2,
        pid: 9,
      })
    }
  })
})

describe("M3: binaryIdentityOf", () => {
  let dir = ""
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "cu-bid-")))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("a file: the real path, the size, and the mtime in seconds", () => {
    const file = join(dir, "ComputerUseHelper")
    writeFileSync(file, "12345")
    utimesSync(file, 1_700_000_000, 1_700_000_000.5)
    expect(binaryIdentityOf(file)).toEqual({ path: file, size: 5, mtime: 1_700_000_000.5 })
  })

  test("a symlink gives the identity of its target", () => {
    const file = join(dir, "ComputerUseHelper")
    writeFileSync(file, "12345")
    const link = join(dir, "link")
    symlinkSync(file, link)
    expect(binaryIdentityOf(link)?.path).toBe(file)
  })

  test("a missing file gives undefined", () => {
    expect(binaryIdentityOf(join(dir, "missing"))).toBeUndefined()
  })

  test("the injected file calls are used", () => {
    const id = binaryIdentityOf("/a", {
      realpath: () => "/real/a",
      stat: () => ({ size: 3, mtimeMs: 1500 }),
    })
    expect(id).toEqual({ path: "/real/a", size: 3, mtime: 1.5 })
  })
})

describe("M3: the handler passes the identity of the binary that it starts", () => {
  test("CUD_HELPER (the extract path) is the compared file", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cu-bid-handler-")))
    try {
      const file = join(dir, "MyHelper")
      writeFileSync(file, "abc")
      const seen: { binary?: BinaryIdentity } = {}
      await runWithDeps(
        {
          trigger: { type: "tool", name: "Computer", input: { action: "ping" } },
          packageDir: "/pkg",
          cwd: "/work",
        } as unknown as TUIContext,
        {
          socketFetch: async () => ({ status: 200, body: {} }),
          extract: (d) => extractHelper(d, { env: { CUD_HELPER: file }, cache: new Map() }),
          ensure: async (d) => {
            seen.binary = d.binary
            return { ok: true }
          },
        },
      )
      expect(seen.binary).toEqual(binaryIdentityOf(file))
      expect(seen.binary?.path).toBe(file)
      expect(seen.binary?.size).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("M3: the Swift side", () => {
  const src = (name: string) =>
    readFileSync(join(import.meta.dir, "..", "native", "Sources", name), "utf8")

  test("ping adds the binary field and keeps protocol 2", () => {
    const router = src("Router.swift")
    expect(router).toContain("static let protocolVersion = 2")
    expect(router).toContain('info["binary"] = binary')
    expect(router).toContain('"path": resolved, "size": size, "mtime": mtime.timeIntervalSince1970')
  })

  test("the daemon reads the identity at start, and the selftest checks it", () => {
    expect(src("main.swift")).toContain("HelperBinary.identity == nil")
    expect(src("SelfTest.swift")).toContain("binaryChecks(ping.json")
  })
})
