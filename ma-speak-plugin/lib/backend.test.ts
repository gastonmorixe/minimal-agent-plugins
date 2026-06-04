import { describe, expect, test } from "bun:test"

import {
  buildSpeechEnv,
  DEFAULT_KILL_GRACE_MS,
  defaultParentExitHook,
  killGroup,
  resolveBackendPath,
  type SpawnedProcess,
  type SpawnFn,
  spawnSpeech,
} from "./backend.ts"
import { defaultConfig } from "./config.ts"

// ---------------------------------------------------------------------------
// resolveBackendPath
// ---------------------------------------------------------------------------

describe("resolveBackendPath", () => {
  test("joins packageDir + backends/<name>.ts", () => {
    expect(resolveBackendPath("/x/y", "macos-say")).toBe("/x/y/backends/macos-say.ts")
  })

  test("rejects path-traversal in backend name", () => {
    for (const bad of ["../foo", "a/b", "a;b", ".."]) {
      expect(() => resolveBackendPath("/x", bad)).toThrow()
    }
  })

  test("accepts hyphens, digits, mixed case", () => {
    expect(resolveBackendPath("/x", "macos-say")).toBe("/x/backends/macos-say.ts")
    expect(resolveBackendPath("/x", "ElevenLabs2")).toBe("/x/backends/ElevenLabs2.ts")
  })
})

// ---------------------------------------------------------------------------
// buildSpeechEnv
// ---------------------------------------------------------------------------

describe("buildSpeechEnv", () => {
  test("inherits base env", () => {
    const env = buildSpeechEnv(undefined, { PATH: "/usr/bin", HOME: "/home/x" })
    expect(env.PATH).toBe("/usr/bin")
    expect(env.HOME).toBe("/home/x")
  })

  test("sets MA_SPEAK_BIN / VOICE / RATE from backend config", () => {
    const env = buildSpeechEnv({ bin: "/usr/bin/say", voice: "Samantha", rate: 180 }, {})
    expect(env.MA_SPEAK_BIN).toBe("/usr/bin/say")
    expect(env.MA_SPEAK_VOICE).toBe("Samantha")
    expect(env.MA_SPEAK_RATE).toBe("180")
  })

  test("omits unset fields", () => {
    const env = buildSpeechEnv({ voice: "Alex" }, {})
    expect(env.MA_SPEAK_VOICE).toBe("Alex")
    expect(env).not.toHaveProperty("MA_SPEAK_BIN")
    expect(env).not.toHaveProperty("MA_SPEAK_RATE")
  })

  test("no backend config → only inherited env, no MA_SPEAK_*", () => {
    const env = buildSpeechEnv(undefined, { FOO: "bar" })
    expect(Object.keys(env).filter((k) => k.startsWith("MA_SPEAK_"))).toEqual([])
  })

  test("drops undefined holes in base env", () => {
    const env = buildSpeechEnv(undefined, { A: "1", B: undefined })
    expect(env.A).toBe("1")
    expect(env).not.toHaveProperty("B")
  })
})

// ---------------------------------------------------------------------------
// killGroup
// ---------------------------------------------------------------------------

describe("killGroup", () => {
  test("falls back to single-pid kill when no pid", () => {
    let single: NodeJS.Signals | number | undefined
    const proc = makeFakeProc({
      pid: undefined,
      kill(sig) {
        single = sig
        return true
      },
    })
    killGroup(proc, "SIGTERM")
    expect(single).toBe("SIGTERM")
  })

  test("never throws when kill throws", () => {
    const proc = makeFakeProc({
      pid: undefined,
      kill() {
        throw new Error("ESRCH")
      },
    })
    expect(() => killGroup(proc, "SIGKILL")).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// defaultParentExitHook
// ---------------------------------------------------------------------------

describe("defaultParentExitHook", () => {
  test("subscribes and returns a working unsubscribe", () => {
    const before = process.listenerCount("exit")
    const unsub = defaultParentExitHook(() => {})
    expect(process.listenerCount("exit")).toBe(before + 1)
    unsub()
    expect(process.listenerCount("exit")).toBe(before)
  })

  test("listener count stays flat across many concurrent subscribers", () => {
    const before = process.listenerCount("exit")
    const sigBefore = process.listenerCount("SIGTERM")
    // 25 concurrent jobs would, under the old per-job model, add 25 listeners
    // to each of 4 events and trip MaxListenersExceededWarning.
    const unsubs = Array.from({ length: 25 }, () => defaultParentExitHook(() => {}))
    expect(process.listenerCount("exit")).toBe(before + 1)
    expect(process.listenerCount("SIGTERM")).toBe(sigBefore + 1)
    for (const u of unsubs) u()
    // Last unsubscribe removes the shared fan-out listeners.
    expect(process.listenerCount("exit")).toBe(before)
    expect(process.listenerCount("SIGTERM")).toBe(sigBefore)
  })

  test("fans out to every subscriber and isolates a throwing callback", () => {
    const calls: string[] = []
    const u1 = defaultParentExitHook(() => calls.push("a"))
    const u2 = defaultParentExitHook(() => {
      calls.push("b")
      throw new Error("boom")
    })
    const u3 = defaultParentExitHook(() => calls.push("c"))
    // Emitting SIGHUP drives the shared dispatch synchronously.
    process.emit("SIGHUP" as never)
    expect(calls.sort()).toEqual(["a", "b", "c"])
    u1()
    u2()
    u3()
  })
})

// ---------------------------------------------------------------------------
// spawnSpeech
// ---------------------------------------------------------------------------

describe("spawnSpeech - misconfiguration", () => {
  test("scriptMissing when backend file does not exist", () => {
    const res = spawnSpeech("/pkg", defaultConfig(), { text: "hi" }, { existsFn: () => false })
    expect(res.ok).toBe(false)
    expect(res.scriptMissing).toBe(true)
    expect(res.backend).toBe("macos-say.ts")
  })

  test("spawnError when spawn throws", () => {
    const res = spawnSpeech(
      "/pkg",
      defaultConfig(),
      { text: "hi" },
      {
        existsFn: () => true,
        spawnFn: () => {
          throw new Error("bun not found")
        },
      },
    )
    expect(res.ok).toBe(false)
    expect(res.spawnError).toMatch(/bun not found/)
  })
})

describe("spawnSpeech - happy path", () => {
  test("returns a controller with the pid and feeds text on stdin", async () => {
    let written = ""
    let ended = false
    let detached = false
    const proc = makeFakeProc({
      pid: 4242,
      stdin: {
        write(s: string) {
          written += s
        },
        end() {
          ended = true
        },
      },
    })
    const spawnFn: SpawnFn = (_argv, opts) => {
      detached = opts.detached === true
      return proc
    }
    const res = spawnSpeech(
      "/pkg",
      defaultConfig(),
      { text: "hello world" },
      { existsFn: () => true, spawnFn, parentExitHook: () => () => {} },
    )
    expect(res.ok).toBe(true)
    expect(res.controller?.pid).toBe(4242)
    expect(written).toBe("hello world")
    expect(ended).toBe(true)
    expect(detached).toBe(true)
    // Let the process "exit" so the exited promise resolves.
    proc.resolveExit(0)
    const exit = await res.exited!
    expect(exit.code).toBe(0)
    expect(exit.killed).toBe(false)
  })

  test("controller.stop() sends SIGTERM via the group then schedules SIGKILL", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = []
    const proc = makeFakeProc({
      pid: undefined, // force single-pid path so we capture proc.kill signals
      kill(sig) {
        signals.push(sig)
        return true
      },
    })
    let scheduled: (() => void) | undefined
    const res = spawnSpeech(
      "/pkg",
      defaultConfig(),
      { text: "x" },
      {
        existsFn: () => true,
        spawnFn: () => proc,
        parentExitHook: () => () => {},
        setTimeoutFn: (cb) => {
          scheduled = cb
          return 0 as unknown as ReturnType<typeof setTimeout>
        },
        clearTimeoutFn: () => {},
      },
    )
    res.controller?.stop()
    expect(signals).toEqual(["SIGTERM"])
    // Fire the escalation timer.
    scheduled?.()
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    // The exited promise must report killed=true.
    proc.resolveExit(-15)
    const exit = await res.exited!
    expect(exit.killed).toBe(true)
  })

  test("parent-exit hook is unsubscribed after the process exits", async () => {
    let unsubscribed = false
    const proc = makeFakeProc({ pid: 1 })
    const res = spawnSpeech(
      "/pkg",
      defaultConfig(),
      { text: "x" },
      {
        existsFn: () => true,
        spawnFn: () => proc,
        parentExitHook: () => () => {
          unsubscribed = true
        },
      },
    )
    proc.resolveExit(0)
    await res.exited
    expect(unsubscribed).toBe(true)
  })

  test("captures stderr from the backend", async () => {
    const proc = makeFakeProc({ pid: 1, stderr: streamOf("boom\n") })
    const res = spawnSpeech(
      "/pkg",
      defaultConfig(),
      { text: "x" },
      { existsFn: () => true, spawnFn: () => proc, parentExitHook: () => () => {} },
    )
    proc.resolveExit(1)
    const exit = await res.exited!
    expect(exit.code).toBe(1)
    expect(exit.stderr).toBe("boom\n")
  })
})

describe("DEFAULT_KILL_GRACE_MS", () => {
  test("is a positive number", () => {
    expect(DEFAULT_KILL_GRACE_MS).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeProc extends SpawnedProcess {
  resolveExit(code: number): void
}

function makeFakeProc(over: Partial<SpawnedProcess>): FakeProc {
  let resolve!: (code: number) => void
  const exited = new Promise<number>((r) => {
    resolve = r
  })
  const base: FakeProc = {
    pid: 1,
    stdin: { write() {}, end() {} },
    stderr: null,
    exited,
    kill() {
      return true
    },
    resolveExit(code: number) {
      resolve(code)
    },
    ...over,
  } as FakeProc
  return base
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
