import { describe, expect, test } from "bun:test"

import type { BackendCallInput, BackendCallResult } from "./backend.ts"
import { defaultConfig, type FetchConfig } from "./config.ts"
import {
  type PersistentSpawnedProcess,
  type PersistentSpawnFn,
  PersistentWorkerClient,
  resolvePersistentWorkerPath,
  toFetchProtocolParams,
} from "./persistent-worker.ts"

const enc = new TextEncoder()

function config(overrides: Partial<FetchConfig> = {}): FetchConfig {
  return {
    ...defaultConfig(),
    storageRoot: "/sessions",
    backends: {
      obscura: { bin: "/managed/bin/obscura", persistent: true, workerIdleSec: 42 },
    },
    ...overrides,
  }
}

function input(overrides: Partial<BackendCallInput> = {}): BackendCallInput {
  return {
    url: "https://example.com",
    format: "markdown",
    waitUntil: "domcontentloaded",
    timeoutSec: 30,
    ...overrides,
  }
}

class FakeWorker {
  readonly requests: Array<Record<string, unknown>> = []
  readonly kills: Array<NodeJS.Signals | number | undefined> = []
  readonly proc: PersistentSpawnedProcess
  private stdoutController!: ReadableStreamDefaultController<Uint8Array>
  private stderrController!: ReadableStreamDefaultController<Uint8Array>
  private exitResolve!: (code: number) => void
  readonly spawn: PersistentSpawnFn
  spawnArgv: string[] | undefined
  spawnEnv: Record<string, string> | undefined
  onRequest: (request: Record<string, unknown>) => void

  constructor() {
    const stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stdoutController = controller
      },
    })
    const stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stderrController = controller
      },
    })
    const stdin = new WritableStream<Uint8Array>({
      write: (chunk) => {
        const line = new TextDecoder().decode(chunk).trim()
        const request = JSON.parse(line) as Record<string, unknown>
        this.requests.push(request)
        queueMicrotask(() => this.onRequest(request))
      },
    })
    const exited = new Promise<number>((resolve) => {
      this.exitResolve = resolve
    })
    this.proc = {
      stdin,
      stdout,
      stderr,
      exited,
      pid: 777,
      kill: (signal) => {
        this.kills.push(signal)
        return true
      },
    }
    this.spawn = (argv, options) => {
      this.spawnArgv = argv
      this.spawnEnv = options.env
      return this.proc
    }
    this.onRequest = (request) => {
      const id = request.id as string
      if (request.op === "hello") {
        this.respond({
          v: 1,
          id,
          ok: true,
          result: {
            protocol: 1,
            pid: 777,
            operations: ["hello", "fetch"],
            supported_formats: ["html", "text", "links", "markdown", "accessibility"],
          },
        })
      } else {
        this.respond({
          v: 1,
          id,
          ok: true,
          result: { body: `body:${(request.params as { url: string }).url}` },
        })
      }
    }
  }

  respond(value: object): void {
    this.stdoutController.enqueue(enc.encode(`${JSON.stringify(value)}\n`))
  }

  stderr(value: string): void {
    this.stderrController.enqueue(enc.encode(value))
  }

  close(code = 0): void {
    try {
      this.stdoutController.close()
    } catch {}
    try {
      this.stderrController.close()
    } catch {}
    this.exitResolve(code)
  }
}

function client(fake: FakeWorker, extra: object = {}): PersistentWorkerClient {
  return new PersistentWorkerClient({
    spawnFn: fake.spawn,
    existsFn: () => true,
    parentExitHook: () => () => {},
    ...extra,
  })
}

function resultOf(value: Awaited<ReturnType<PersistentWorkerClient["call"]>>): BackendCallResult {
  expect(value.kind).toBe("result")
  if (value.kind !== "result") throw new Error("expected result")
  return value.result
}

describe("persistent worker adapter", () => {
  test("resolves worker beside configured binary", () => {
    expect(resolvePersistentWorkerPath(config(), {}, () => true)).toBe(
      "/managed/bin/obscura-worker",
    )
  })

  test("translates generic input and derives a sandboxed session name", () => {
    expect(
      toFetchProtocolParams(
        input({
          waitUntil: "networkidle0",
          timeoutSec: 12,
          selector: "main",
          evalExpr: "document.title",
          storageDir: "/sessions/twitter",
        }),
        config(),
      ),
    ).toEqual({
      url: "https://example.com",
      format: "markdown",
      wait_until: "networkidle0",
      timeout_ms: 12_000,
      settle_ms: 5_000,
      selector: "main",
      eval: "document.title",
      session: "twitter",
      storage_dir: "/sessions/twitter",
    })
  })

  test("rejects storage outside the configured root", () => {
    expect(() =>
      toFetchProtocolParams(input({ storageDir: "/sessions/../escape" }), config()),
    ).toThrow("outside")
  })

  test("keeps original on the one-shot path", () => {
    expect(() => toFetchProtocolParams(input({ format: "original" }), config())).toThrow(
      "not supported",
    )
  })

  test("passes accessibility through the persistent protocol", () => {
    expect(toFetchProtocolParams(input({ format: "accessibility" }), config()).format).toBe(
      "accessibility",
    )
  })
})

describe("PersistentWorkerClient", () => {
  test("is lazy, performs hello once, and reuses the worker", async () => {
    const fake = new FakeWorker()
    let spawns = 0
    const spawnFn: PersistentSpawnFn = (...args) => {
      spawns++
      return fake.spawn(...args)
    }
    const c = new PersistentWorkerClient({
      spawnFn,
      existsFn: () => true,
      parentExitHook: () => () => {},
    })
    expect(spawns).toBe(0)

    const first = resultOf(await c.call(config(), input(), new AbortController().signal))
    const second = resultOf(
      await c.call(config(), input({ url: "https://two.example" }), new AbortController().signal),
    )
    expect(first.stdout).toBe("body:https://example.com")
    expect(second.stdout).toBe("body:https://two.example")
    expect(spawns).toBe(1)
    expect(fake.spawnArgv).toEqual(["/managed/bin/obscura-worker", "--fetch-protocol"])
    expect(fake.spawnEnv?.OBSCURA_FETCH_WORKER_IDLE_TIMEOUT_SECS).toBe("42")
    expect(fake.spawnEnv?.OBSCURA_FETCH_WORKER_EXTENSION).toBeUndefined()
    expect(fake.requests.map((request) => request.op)).toEqual(["hello", "fetch", "fetch"])
    expect(c.status()).toEqual({ running: true, pid: 777, protocol: 1 })
    fake.close()
  })

  test("forwards the first configured extension to the worker environment", async () => {
    const fake = new FakeWorker()
    const c = client(fake)
    const cfg = config()
    cfg.backends.obscura = {
      ...cfg.backends.obscura,
      extensions: ["/extensions/one.xpi", "/extensions/two.crx"],
    }
    await c.call(cfg, input(), new AbortController().signal)
    expect(fake.spawnEnv?.OBSCURA_FETCH_WORKER_EXTENSION).toBe("/extensions/one.xpi")
    fake.close()
  })

  test("serializes concurrent requests", async () => {
    const fake = new FakeWorker()
    const pending: Array<Record<string, unknown>> = []
    fake.onRequest = (request) => {
      if (request.op === "hello") {
        fake.respond({
          v: 1,
          id: request.id,
          ok: true,
          result: {
            protocol: 1,
            pid: 777,
            operations: ["hello", "fetch"],
            supported_formats: ["html", "text", "links", "markdown", "accessibility"],
          },
        })
      } else {
        pending.push(request)
      }
    }
    const c = client(fake)
    const a = c.call(config(), input({ url: "https://a" }), new AbortController().signal)
    const b = c.call(config(), input({ url: "https://b" }), new AbortController().signal)
    await Bun.sleep(0)
    expect(pending).toHaveLength(1)
    fake.respond({ v: 1, id: pending[0].id, ok: true, result: { body: "a" } })
    await a
    await Bun.sleep(0)
    expect(pending).toHaveLength(2)
    fake.respond({ v: 1, id: pending[1].id, ok: true, result: { body: "b" } })
    expect(resultOf(await b).stdout).toBe("b")
    fake.close()
  })

  test("falls back when worker is unavailable without spawning", async () => {
    let spawned = false
    const c = new PersistentWorkerClient({
      spawnFn: () => {
        spawned = true
        throw new Error("must not spawn")
      },
      existsFn: () => false,
      parentExitHook: () => () => {},
    })
    const result = await c.call(config(), input(), new AbortController().signal)
    expect(result.kind).toBe("fallback")
    expect(spawned).toBe(false)
  })

  test("falls back when an old worker lacks accessibility format", async () => {
    const fake = new FakeWorker()
    fake.onRequest = (request) => {
      fake.respond({
        v: 1,
        id: request.id,
        ok: true,
        result: { protocol: 1, pid: 777, operations: ["hello", "fetch"] },
      })
    }
    const result = await client(fake).call(
      config(),
      input({ format: "accessibility" }),
      new AbortController().signal,
    )
    expect(result.kind).toBe("fallback")
    fake.close()
  })

  test("falls back when hello reports protocol skew", async () => {
    const fake = new FakeWorker()
    fake.onRequest = (request) => {
      fake.respond({
        v: 1,
        id: request.id,
        ok: true,
        result: { protocol: 2, pid: 777, operations: ["hello", "fetch"] },
      })
    }
    const result = await client(fake).call(config(), input(), new AbortController().signal)
    expect(result.kind).toBe("fallback")
    expect(fake.kills).toContain("SIGKILL")
    fake.close()
  })

  test("does not replay after a dispatched fetch fails", async () => {
    const fake = new FakeWorker()
    let fetches = 0
    fake.onRequest = (request) => {
      if (request.op === "hello") {
        fake.respond({
          v: 1,
          id: request.id,
          ok: true,
          result: {
            protocol: 1,
            pid: 777,
            operations: ["hello", "fetch"],
            supported_formats: ["html", "text", "links", "markdown", "accessibility"],
          },
        })
      } else {
        fetches++
        fake.close(1)
      }
    }
    const result = resultOf(
      await client(fake).call(config(), input(), new AbortController().signal),
    )
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain("after dispatch")
    expect(fetches).toBe(1)
  })

  test("abort kills the process group boundary and marks the result", async () => {
    const fake = new FakeWorker()
    const ctrl = new AbortController()
    fake.onRequest = (request) => {
      if (request.op === "hello") {
        fake.respond({
          v: 1,
          id: request.id,
          ok: true,
          result: {
            protocol: 1,
            pid: 777,
            operations: ["hello", "fetch"],
            supported_formats: ["html", "text", "links", "markdown", "accessibility"],
          },
        })
      } else {
        ctrl.abort()
      }
    }
    const result = resultOf(await client(fake).call(config(), input(), ctrl.signal))
    expect(result.aborted).toBe(true)
    expect(result.abortReason).toBe("signal")
    expect(fake.kills).toContain("SIGKILL")
    fake.close()
  })

  test("caps stderr retained with a successful response", async () => {
    const fake = new FakeWorker()
    fake.stderr("x".repeat(80 * 1024))
    const result = resultOf(
      await client(fake).call(config(), input(), new AbortController().signal),
    )
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64 * 1024)
    fake.close()
  })

  test("a later call starts a clean worker after a crash", async () => {
    const first = new FakeWorker()
    const second = new FakeWorker()
    const workers = [first, second]
    let spawnIndex = 0
    const c = new PersistentWorkerClient({
      spawnFn: (...args) => workers[spawnIndex++].spawn(...args),
      existsFn: () => true,
      parentExitHook: () => () => {},
    })
    expect(resultOf(await c.call(config(), input(), new AbortController().signal)).ok).toBe(true)
    first.close(1)
    await Bun.sleep(0)
    expect(
      resultOf(
        await c.call(config(), input({ url: "https://after-crash" }), new AbortController().signal),
      ).stdout,
    ).toBe("body:https://after-crash")
    expect(spawnIndex).toBe(2)
    second.close()
  })

  test("parent-exit hook kills the worker", async () => {
    const fake = new FakeWorker()
    let parentExit: (() => void) | undefined
    const c = client(fake, {
      parentExitHook: (callback: () => void) => {
        parentExit = callback
        return () => {}
      },
    })
    await c.call(config(), input(), new AbortController().signal)
    parentExit?.()
    expect(fake.kills).toContain("SIGKILL")
    fake.close()
  })

  test("outer watchdog kills the worker and reports timeout", async () => {
    const fake = new FakeWorker()
    fake.onRequest = (request) => {
      if (request.op === "hello") {
        fake.respond({
          v: 1,
          id: request.id,
          ok: true,
          result: {
            protocol: 1,
            pid: 777,
            operations: ["hello", "fetch"],
            supported_formats: ["html", "text", "links", "markdown", "accessibility"],
          },
        })
      }
    }
    const timers: Array<{ ms: number; callback: () => void }> = []
    const c = client(fake, {
      setTimeoutFn: (callback: () => void, ms: number) => {
        timers.push({ ms, callback })
        return timers.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeoutFn: () => {},
      watchdogSlackSec: 5,
    })
    const promise = c.call(config(), input({ timeoutSec: 7 }), new AbortController().signal)
    await Bun.sleep(0)
    const watchdog = timers.find((timer) => timer.ms === 12_000)
    expect(watchdog).toBeDefined()
    watchdog?.callback()
    const result = resultOf(await promise)
    expect(result.aborted).toBe(true)
    expect(result.abortReason).toBe("watchdog")
    expect(result.stderr).toContain("outer watchdog")
    fake.close()
  })
})
