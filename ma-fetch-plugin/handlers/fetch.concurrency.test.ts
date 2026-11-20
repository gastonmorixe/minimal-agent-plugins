import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import type { BackendCallInput, SpawnedProcess, SpawnFn } from "../lib/backend.ts"
import { defaultConfig, type FetchConfig } from "../lib/config.ts"
import { FifoSemaphore } from "../lib/one-shot-slots.ts"
import type { PersistentCallResult } from "../lib/persistent-worker.ts"
import type { TUIContext, TUIResult } from "../lib/types.ts"

import { concurrencySafe, concurrencySafeWith, type FetchRunDeps, runWithDeps } from "./fetch.ts"

// callBackend refuses to spawn without a managed bin dir (see fetch.run.test.ts).
const SAVED_BIN_DIR = process.env.MINIMAL_AGENT_BIN_DIR
beforeAll(() => {
  process.env.MINIMAL_AGENT_BIN_DIR = "/managed/bin"
})
afterAll(() => {
  if (SAVED_BIN_DIR === undefined) delete process.env.MINIMAL_AGENT_BIN_DIR
  else process.env.MINIMAL_AGENT_BIN_DIR = SAVED_BIN_DIR
})

const enc = new TextEncoder()

/** A fake one-shot process that ends when the test calls `finish`. */
function gatedProc(stdout: string): { proc: SpawnedProcess; finish: () => void } {
  let finish!: () => void
  const exited = new Promise<number>((resolve) => {
    finish = () => resolve(0)
  })
  let out!: ReadableStreamDefaultController<Uint8Array>
  const stdoutStream = new ReadableStream<Uint8Array>({
    start(c) {
      out = c
    },
  })
  const stderrStream = new ReadableStream<Uint8Array>({
    start(c) {
      c.close()
    },
  })
  let done = false
  return {
    proc: {
      stdout: stdoutStream,
      stderr: stderrStream,
      exited,
      kill: () => true,
    },
    finish: () => {
      if (done) return
      done = true
      out.enqueue(enc.encode(stdout))
      out.close()
      finish()
    },
  }
}

function ctx(signal: AbortSignal = new AbortController().signal): TUIContext {
  return {
    trigger: { type: "tool", name: "Fetch", input: {} },
    packageDir: "/plugin",
    cwd: "/cwd",
    env: {},
    abort: signal,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  }
}

function input(overrides: Partial<BackendCallInput> = {}): BackendCallInput {
  return {
    url: "https://example.com",
    format: "markdown",
    waitUntil: "load",
    timeoutSec: 30,
    ...overrides,
  }
}

function toolResult(r: TUIResult): Extract<TUIResult, { kind: "tool_result" }> {
  if (r.kind !== "tool_result") throw new Error("expected tool_result")
  return r
}

/** A gated spawn: each spawn is recorded; the test ends each process. */
function gatedSpawn() {
  const procs: Array<{ url: string; finish: () => void }> = []
  const spawnFn: SpawnFn = (_argv, opts) => {
    const url = opts.env?.MA_FETCH_URL ?? ""
    const g = gatedProc(`body of ${url}`)
    procs.push({ url, finish: g.finish })
    return g.proc
  }
  return { procs, spawnFn }
}

const baseDeps = (extra: Partial<FetchRunDeps> = {}): FetchRunDeps => ({
  existsFn: () => true,
  parentExitHook: () => () => {},
  oneShotSlots: new FifoSemaphore(4),
  ...extra,
})

function persistentResult(stdout: string): PersistentCallResult {
  return {
    kind: "result",
    workerPid: 2_000_000_001,
    result: {
      ok: true,
      exitCode: 0,
      stdout,
      stdoutBytes: enc.encode(stdout),
      stderr: "",
      backend: "obscura.ts",
    },
  }
}

describe("concurrencySafe export", () => {
  const noDefault = (): FetchConfig => defaultConfig()
  const withDefault = (): FetchConfig => ({
    ...defaultConfig(),
    defaults: { ...defaultConfig().defaults, session: "work" },
  })

  test("true when session is absent or empty", () => {
    expect(concurrencySafeWith({ url: "https://a" }, noDefault)).toBe(true)
    expect(concurrencySafeWith({ url: "https://a", session: "" }, noDefault)).toBe(true)
    expect(concurrencySafeWith({ url: "https://a", session: "" }, withDefault)).toBe(true)
  })

  test("false for a named session", () => {
    expect(concurrencySafeWith({ url: "https://a", session: "x" }, noDefault)).toBe(false)
  })

  test("false when the config sets a default session and the input has none", () => {
    expect(concurrencySafeWith({ url: "https://a" }, withDefault)).toBe(false)
  })

  test("the default export form gives a boolean from one input argument", () => {
    expect(concurrencySafe.length).toBe(1)
    expect(concurrencySafe({ url: "https://a", session: "named" })).toBe(false)
    expect(concurrencySafe({ url: "https://a", session: "" })).toBe(true)
  })
})

describe("one-shot calls without a session overlap", () => {
  test("two calls run at the same time", async () => {
    const { procs, spawnFn } = gatedSpawn()
    const deps = baseDeps({ spawnFn })
    const a = runWithDeps(ctx(), defaultConfig(), input({ url: "https://a" }), deps)
    const b = runWithDeps(ctx(), defaultConfig(), input({ url: "https://b" }), deps)
    await Bun.sleep(5)
    // Both processes started before one of them ended.
    expect(procs.map((p) => p.url)).toEqual(["https://a", "https://b"])
    procs[1].finish()
    procs[0].finish()
    expect(toolResult(await a).content).toBe("body of https://a")
    expect(toolResult(await b).content).toBe("body of https://b")
    expect(deps.oneShotSlots?.running).toBe(0)
  })

  test("calls with the same named session: the plugin marks them serial; core orders them", () => {
    // Core runs a serial call alone (SPEC D2). At the plugin level, the
    // proof is that each call with a named session is not concurrency-safe.
    const a = { url: "https://a", session: "s1" }
    const b = { url: "https://b", session: "s1" }
    expect(concurrencySafeWith(a, defaultConfig)).toBe(false)
    expect(concurrencySafeWith(b, defaultConfig)).toBe(false)
  })
})

describe("busy persistent worker", () => {
  function counters() {
    const c = { persistent: 0, oneShot: 0 }
    const spawnFn: SpawnFn = () => {
      c.oneShot++
      const g = gatedProc("one-shot")
      g.finish()
      return g.proc
    }
    const persistentCall = async () => {
      c.persistent++
      return persistentResult("persistent")
    }
    return { c, spawnFn, persistentCall }
  }

  test("a call without a session uses the one-shot path when the worker is busy", async () => {
    const { c, spawnFn, persistentCall } = counters()
    const r = await runWithDeps(
      ctx(),
      defaultConfig(),
      input(),
      baseDeps({ spawnFn, persistentCall, persistentBusy: () => true }),
    )
    const out = toolResult(r)
    expect(out.content).toBe("one-shot")
    expect(out.is_error).toBeUndefined()
    expect(c).toEqual({ persistent: 0, oneShot: 1 })
  })

  test("a call without a session uses the worker when it is free", async () => {
    const { c, spawnFn, persistentCall } = counters()
    const r = await runWithDeps(
      ctx(),
      defaultConfig(),
      input(),
      baseDeps({ spawnFn, persistentCall, persistentBusy: () => false }),
    )
    expect(toolResult(r).content).toBe("persistent")
    expect(c).toEqual({ persistent: 1, oneShot: 0 })
  })

  test("a call with a session and an accessibility call still wait for the worker", async () => {
    const { c, spawnFn, persistentCall } = counters()
    const deps = baseDeps({ spawnFn, persistentCall, persistentBusy: () => true })
    await runWithDeps(ctx(), defaultConfig(), input({ storageDir: "/s/work" }), deps)
    await runWithDeps(ctx(), defaultConfig(), input({ format: "accessibility" }), deps)
    expect(c).toEqual({ persistent: 2, oneShot: 0 })
  })
})

describe("one-shot cap: conditions", () => {
  test("6 calls with cap 4: 4 start, then 5 and 6 in arrival order", async () => {
    const { procs, spawnFn } = gatedSpawn()
    const deps = baseDeps({ spawnFn })
    const urls = [1, 2, 3, 4, 5, 6].map((n) => `https://p${n}`)
    const runs = urls.map((url) => runWithDeps(ctx(), defaultConfig(), input({ url }), deps))
    await Bun.sleep(5)
    expect(procs.map((p) => p.url)).toEqual(urls.slice(0, 4))
    procs[2].finish()
    await Bun.sleep(5)
    expect(procs.map((p) => p.url)).toEqual(urls.slice(0, 5))
    procs[0].finish()
    await Bun.sleep(5)
    expect(procs.map((p) => p.url)).toEqual(urls)
    for (const p of procs) p.finish()
    await Promise.all(runs)
    expect(deps.oneShotSlots?.running).toBe(0)
  })

  test("a: the watchdog timer starts only after the call gets its slot", async () => {
    const { procs, spawnFn } = gatedSpawn()
    const timers: number[] = []
    const slots = new FifoSemaphore(1)
    const held = await slots.acquire()
    const deps = baseDeps({
      spawnFn,
      oneShotSlots: slots,
      setTimeoutFn: (_cb, ms) => {
        timers.push(ms)
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeoutFn: () => {},
    })
    const run = runWithDeps(ctx(), defaultConfig(), input({ timeoutSec: 1 }), deps)
    await Bun.sleep(5)
    // The call waits: no process and no timer yet.
    expect(procs).toHaveLength(0)
    expect(timers).toHaveLength(0)
    held?.release()
    await Bun.sleep(5)
    expect(procs).toHaveLength(1)
    expect(timers).toHaveLength(1)
    procs[0].finish()
    expect(toolResult(await run).content).toBe("body of https://example.com")
    expect(slots.running).toBe(0)
  })

  test("b: abort while waiting removes the call and releases nothing", async () => {
    const { procs, spawnFn } = gatedSpawn()
    const slots = new FifoSemaphore(1)
    const held = await slots.acquire()
    const ac = new AbortController()
    const deps = baseDeps({ spawnFn, oneShotSlots: slots })
    const run = runWithDeps(ctx(ac.signal), defaultConfig(), input(), deps)
    await Bun.sleep(5)
    expect(slots.waiting).toBe(1)
    ac.abort()
    const out = toolResult(await run)
    expect(out.is_error).toBe(true)
    expect(out.content).toContain("aborted")
    expect(procs).toHaveLength(0)
    expect(slots.waiting).toBe(0)
    // The slot of the other owner stays in use.
    expect(slots.running).toBe(1)
    held?.release()
    expect(slots.running).toBe(0)
  })

  test("b: a call that throws releases its slot", async () => {
    const slots = new FifoSemaphore(1)
    const deps = baseDeps({
      spawnFn: gatedSpawn().spawnFn,
      oneShotSlots: slots,
      existsFn: () => {
        throw new Error("disk error")
      },
    })
    await expect(runWithDeps(ctx(), defaultConfig(), input(), deps)).rejects.toThrow("disk error")
    expect(slots.running).toBe(0)
  })
})
