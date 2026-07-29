import { describe, expect, test } from "bun:test"

import {
  buildBackendEnv,
  callBackend,
  DEFAULT_WATCHDOG_SLACK_SEC,
  defaultParentExitHook,
  killBackend,
  resolveBackendBin,
  resolveBackendPath,
  type SpawnedProcess,
  type SpawnFn,
} from "./backend.ts"
import { defaultConfig, type FetchConfig } from "./config.ts"

/**
 * A config whose backend binary resolves via the operator-override path
 * (`backends.obscura.bin`). The override wins in {@link resolveBackendBin}
 * without consulting `MINIMAL_AGENT_BIN_DIR` or the filesystem, so any
 * `callBackend` test that expects to actually SPAWN must use this (the new
 * fail-closed precheck refuses to spawn when no binary resolves). Pure spawn
 * orchestration is what those tests exercise; the binary path is incidental.
 */
function binCfg(overrides: Partial<FetchConfig> = {}): FetchConfig {
  return {
    ...defaultConfig(),
    backends: { obscura: { bin: "/managed/obscura" } },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// resolveBackendPath
// ---------------------------------------------------------------------------

describe("resolveBackendPath", () => {
  test("joins packageDir + backends/<name>.ts", () => {
    expect(resolveBackendPath("/x/y", "obscura")).toBe("/x/y/backends/obscura.ts")
  })

  test("rejects path-traversal in backend name", () => {
    for (const bad of ["../foo", "a/b", "a;b", ".."]) {
      expect(() => resolveBackendPath("/x", bad)).toThrow()
    }
  })

  test("accepts hyphens, digits, mixed case", () => {
    expect(resolveBackendPath("/x", "obscura-2")).toBe("/x/backends/obscura-2.ts")
    expect(resolveBackendPath("/x", "Playwright")).toBe("/x/backends/Playwright.ts")
  })
})

// ---------------------------------------------------------------------------
// resolveBackendBin - the fail-closed binary resolver (NEVER PATH)
// ---------------------------------------------------------------------------

describe("resolveBackendBin", () => {
  const present = () => true
  const absent = () => false

  test("operator override wins, verbatim, no env or fs needed", () => {
    const cfg: FetchConfig = {
      ...defaultConfig(),
      backends: { obscura: { bin: "/custom/obscura" } },
    }
    // Override is used even with no MINIMAL_AGENT_BIN_DIR and existsFn=absent:
    // the operator owns that path.
    expect(resolveBackendBin(cfg, {}, absent)).toBe("/custom/obscura")
  })

  test("override is per-active-backend (a sibling backend's bin is ignored)", () => {
    const cfg: FetchConfig = {
      ...defaultConfig(),
      backend: "obscura",
      backends: { playwright: { bin: "/pw/bin" } },
    }
    // No obscura override + no bin dir → null (not the playwright override).
    expect(resolveBackendBin(cfg, {}, absent)).toBeNull()
  })

  test("resolves <MINIMAL_AGENT_BIN_DIR>/<backend> when the file exists", () => {
    expect(resolveBackendBin(defaultConfig(), { MINIMAL_AGENT_BIN_DIR: "/m/bin" }, present)).toBe(
      "/m/bin/obscura",
    )
  })

  test("returns null when the managed candidate does not exist (fail closed)", () => {
    expect(
      resolveBackendBin(defaultConfig(), { MINIMAL_AGENT_BIN_DIR: "/m/bin" }, absent),
    ).toBeNull()
  })

  test("returns null when MINIMAL_AGENT_BIN_DIR is unset (NEVER falls back to PATH)", () => {
    expect(resolveBackendBin(defaultConfig(), {}, present)).toBeNull()
  })

  test("ignores a non-absolute MINIMAL_AGENT_BIN_DIR", () => {
    expect(
      resolveBackendBin(defaultConfig(), { MINIMAL_AGENT_BIN_DIR: "relative/bin" }, present),
    ).toBeNull()
  })

  test("honors the active backend name in the candidate path", () => {
    const cfg: FetchConfig = { ...defaultConfig(), backend: "playwright" }
    expect(resolveBackendBin(cfg, { MINIMAL_AGENT_BIN_DIR: "/m/bin" }, present)).toBe(
      "/m/bin/playwright",
    )
  })
})

// ---------------------------------------------------------------------------
// buildBackendEnv
// ---------------------------------------------------------------------------

describe("buildBackendEnv - required fields", () => {
  test("MA_FETCH_URL / FORMAT / WAIT_UNTIL / TIMEOUT_SEC set from input", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      {
        url: "https://example.com",
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
      },
      {},
    )
    expect(env.MA_FETCH_URL).toBe("https://example.com")
    expect(env.MA_FETCH_FORMAT).toBe("markdown")
    expect(env.MA_FETCH_WAIT_UNTIL).toBe("load")
    expect(env.MA_FETCH_TIMEOUT_SEC).toBe("30")
  })

  test("timeoutSec is stringified", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 45 },
      {},
    )
    expect(env.MA_FETCH_TIMEOUT_SEC).toBe("45")
  })
})

describe("buildBackendEnv - optional fields", () => {
  test("MA_FETCH_SELECTOR set when input provides selector", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      {
        url: "https://x",
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
        selector: "main",
      },
      {},
    )
    expect(env.MA_FETCH_SELECTOR).toBe("main")
  })

  test("MA_FETCH_SELECTOR absent when input omits it", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      {},
    )
    expect(env).not.toHaveProperty("MA_FETCH_SELECTOR")
  })

  test("MA_FETCH_EVAL set when input provides evalExpr", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      {
        url: "https://x",
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
        evalExpr: "document.title",
      },
      {},
    )
    expect(env.MA_FETCH_EVAL).toBe("document.title")
    expect(env.MA_FETCH_EVAL_MODE).toBe("value")
  })

  test("MA_FETCH_EVAL_MODE preserves explicit page mode", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      {
        url: "https://x",
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
        evalExpr: "document.querySelector('form').submit()",
        evalMode: "page",
      },
      {},
    )
    expect(env.MA_FETCH_EVAL_MODE).toBe("page")
  })

  test("empty-string optional fields are NOT set", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      {
        url: "https://x",
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
        selector: "",
        evalExpr: "",
      },
      {},
    )
    expect(env).not.toHaveProperty("MA_FETCH_SELECTOR")
    expect(env).not.toHaveProperty("MA_FETCH_EVAL")
    expect(env).not.toHaveProperty("MA_FETCH_EVAL_MODE")
  })
})

describe("buildBackendEnv - config-applied fields", () => {
  test("MA_FETCH_USER_AGENT comes from config, not input", () => {
    const cfg: FetchConfig = { ...defaultConfig(), userAgent: "MyBot/1.0" }
    const env = buildBackendEnv(
      cfg,
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      {},
    )
    expect(env.MA_FETCH_USER_AGENT).toBe("MyBot/1.0")
  })

  test("MA_FETCH_PROXY comes from config", () => {
    const cfg: FetchConfig = { ...defaultConfig(), proxy: "http://corp:8080" }
    const env = buildBackendEnv(
      cfg,
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      {},
    )
    expect(env.MA_FETCH_PROXY).toBe("http://corp:8080")
  })

  test("MA_FETCH_BIN comes from config.backends[backend].bin (operator override)", () => {
    const cfg: FetchConfig = {
      ...defaultConfig(),
      backends: { obscura: { bin: "/opt/obscura/bin/obscura" } },
    }
    const env = buildBackendEnv(
      cfg,
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      {},
    )
    expect(env.MA_FETCH_BIN).toBe("/opt/obscura/bin/obscura")
  })

  test("MA_FETCH_BIN resolves from MINIMAL_AGENT_BIN_DIR/<backend> when present", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { MINIMAL_AGENT_BIN_DIR: "/home/u/.minimal-agent/bin" },
      // NOTE: buildBackendEnv uses the default existsSync; this dir won't
      // exist in CI, so MA_FETCH_BIN is correctly LEFT UNSET. The resolution
      // logic itself (with an injectable existsFn) is covered in the
      // resolveBackendBin describe block below.
    )
    // Fail-closed: the candidate path does not exist on the test box.
    expect(env).not.toHaveProperty("MA_FETCH_BIN")
  })

  test("MA_FETCH_BIN absent when no override and no MINIMAL_AGENT_BIN_DIR (never PATH)", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      {},
    )
    expect(env).not.toHaveProperty("MA_FETCH_BIN")
  })

  test("config-fields absent when null/missing", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      {},
    )
    expect(env).not.toHaveProperty("MA_FETCH_USER_AGENT")
    expect(env).not.toHaveProperty("MA_FETCH_PROXY")
    expect(env).not.toHaveProperty("MA_FETCH_BIN")
    expect(env).not.toHaveProperty("MA_FETCH_EXTENSIONS")
  })

  test("MA_FETCH_EXTENSIONS comes from config.backends[backend].extensions, joined by \\n", () => {
    const cfg: FetchConfig = {
      ...defaultConfig(),
      backends: {
        obscura: {
          extensions: ["/path/bpc.xpi", "/path/ublock.crx"],
        },
      },
    }
    const env = buildBackendEnv(
      cfg,
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      {},
    )
    expect(env.MA_FETCH_EXTENSIONS).toBe("/path/bpc.xpi\n/path/ublock.crx")
  })

  test("MA_FETCH_EXTENSIONS absent when extensions is empty array", () => {
    const cfg: FetchConfig = {
      ...defaultConfig(),
      backends: { obscura: { extensions: [] } },
    }
    const env = buildBackendEnv(
      cfg,
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      {},
    )
    expect(env).not.toHaveProperty("MA_FETCH_EXTENSIONS")
  })

  test("MA_FETCH_EXTENSIONS only forwarded for the active backend", () => {
    // extensions set on `playwright` but active backend is `obscura` →
    // not forwarded. Keeps backends isolated.
    const cfg: FetchConfig = {
      ...defaultConfig(),
      backend: "obscura",
      backends: { playwright: { extensions: ["/path/foo.xpi"] } },
    }
    const env = buildBackendEnv(
      cfg,
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      {},
    )
    expect(env).not.toHaveProperty("MA_FETCH_EXTENSIONS")
  })
})

describe("buildBackendEnv - base env inheritance", () => {
  test("inherits PATH and other env from baseEnv", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { PATH: "/usr/local/bin:/usr/bin", HOME: "/Users/test" },
    )
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin")
    expect(env.HOME).toBe("/Users/test")
  })

  test("MA_FETCH_* in baseEnv is overridden by input/config", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      {
        url: "https://NEW",
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
      },
      { MA_FETCH_URL: "https://STALE" },
    )
    expect(env.MA_FETCH_URL).toBe("https://NEW")
  })

  test("undefined entries in baseEnv are filtered out", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { PATH: "/usr/bin", MISSING: undefined as unknown as string },
    )
    expect(env).not.toHaveProperty("MISSING")
  })
})

// ---------------------------------------------------------------------------
// callBackend - orchestration (with fake spawn)
// ---------------------------------------------------------------------------

/** Build a fake `SpawnedProcess` from canned outputs. */
function fakeProc(opts: {
  stdout?: string
  stderr?: string
  exitCode?: number
  exitDelayMs?: number
}): SpawnedProcess {
  const enc = new TextEncoder()
  const mkStream = (s: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (s.length > 0) controller.enqueue(enc.encode(s))
        controller.close()
      },
    })
  const exited =
    opts.exitDelayMs && opts.exitDelayMs > 0
      ? new Promise<number>((res) => setTimeout(() => res(opts.exitCode ?? 0), opts.exitDelayMs))
      : Promise.resolve(opts.exitCode ?? 0)
  return {
    stdout: mkStream(opts.stdout ?? ""),
    stderr: mkStream(opts.stderr ?? ""),
    exited,
    kill: () => true,
  }
}

describe("callBackend - happy path", () => {
  test("captures stdout/stderr/exit and reports ok=true on exit 0", async () => {
    const calls: Array<{ argv: string[]; env: Record<string, string> }> = []
    const spawnFn: SpawnFn = (argv, options) => {
      calls.push({ argv: [...argv], env: { ...options.env } })
      return fakeProc({ stdout: "page body", stderr: "info: ok", exitCode: 0 })
    }
    const result = await callBackend(
      "/plugin",
      binCfg(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      new AbortController().signal,
      { spawnFn, existsFn: () => true },
    )
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("page body")
    expect(result.stderr).toBe("info: ok")
    expect(result.backend).toBe("obscura.ts")
    expect(calls).toHaveLength(1)
    expect(calls[0].argv).toEqual(["bun", "/plugin/backends/obscura.ts"])
    expect(calls[0].env.MA_FETCH_URL).toBe("https://x")
  })

  test("reports ok=false on non-zero exit", async () => {
    const spawnFn: SpawnFn = () =>
      fakeProc({ stdout: "", stderr: "navigation failed", exitCode: 1 })
    const result = await callBackend(
      "/plugin",
      binCfg(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      new AbortController().signal,
      { spawnFn, existsFn: () => true },
    )
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("navigation failed")
  })
})

describe("callBackend - failure modes", () => {
  test("missing backend script → scriptMissing=true, no spawn attempted", async () => {
    let spawned = false
    const spawnFn: SpawnFn = () => {
      spawned = true
      return fakeProc({})
    }
    const result = await callBackend(
      "/plugin",
      defaultConfig(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      new AbortController().signal,
      { spawnFn, existsFn: () => false },
    )
    expect(result.ok).toBe(false)
    expect(result.scriptMissing).toBe(true)
    expect(result.stderr).toContain("backend script not found")
    expect(result.stderr).toContain("/plugin/backends/obscura.ts")
    expect(spawned).toBe(false)
  })

  test("spawn throws → reports failure cleanly", async () => {
    const spawnFn: SpawnFn = () => {
      throw new Error("ENOENT")
    }
    const result = await callBackend(
      "/plugin",
      binCfg(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      new AbortController().signal,
      { spawnFn, existsFn: () => true },
    )
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain("failed to spawn")
    expect(result.stderr).toContain("ENOENT")
  })

  test("no resolvable binary → binUnavailable=true, NO spawn (never PATH)", async () => {
    // The backend SCRIPT exists (existsFn true) but no override is set and the
    // env carries no MINIMAL_AGENT_BIN_DIR, so the managed binary can't be
    // resolved. The dispatcher must refuse to spawn rather than run a bare
    // `obscura` off PATH.
    const prev = process.env.MINIMAL_AGENT_BIN_DIR
    process.env.MINIMAL_AGENT_BIN_DIR = ""
    try {
      let spawned = false
      const spawnFn: SpawnFn = () => {
        spawned = true
        return fakeProc({})
      }
      const result = await callBackend(
        "/plugin",
        defaultConfig(), // no operator override
        { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
        new AbortController().signal,
        { spawnFn, existsFn: () => true },
      )
      expect(result.ok).toBe(false)
      expect(result.binUnavailable).toBe(true)
      expect(result.scriptMissing).toBeUndefined()
      expect(result.stderr).toContain("no managed binary resolved")
      expect(spawned).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_BIN_DIR
      else process.env.MINIMAL_AGENT_BIN_DIR = prev
    }
  })
})

describe("callBackend - abort", () => {
  test("abort signal fires kill and marks result aborted=true", async () => {
    let killed = false
    const spawnFn: SpawnFn = () => ({
      ...fakeProc({ exitCode: 143, exitDelayMs: 50 }),
      kill: () => {
        killed = true
        return true
      },
    })
    const ctrl = new AbortController()
    const promise = callBackend(
      "/plugin",
      binCfg(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      ctrl.signal,
      { spawnFn, existsFn: () => true },
    )
    // Abort immediately after spawn.
    queueMicrotask(() => ctrl.abort())
    const result = await promise
    expect(killed).toBe(true)
    expect(result.aborted).toBe(true)
    expect(result.ok).toBe(false)
  })

  test("pre-aborted signal kills before reading streams", async () => {
    let killed = false
    const spawnFn: SpawnFn = () => ({
      ...fakeProc({ exitCode: 143 }),
      kill: () => {
        killed = true
        return true
      },
    })
    const ctrl = new AbortController()
    ctrl.abort() // already aborted before callBackend is even called
    const result = await callBackend(
      "/plugin",
      binCfg(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      ctrl.signal,
      { spawnFn, existsFn: () => true },
    )
    expect(killed).toBe(true)
    expect(result.aborted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// callBackend - detached spawn (process-group isolation)
// ---------------------------------------------------------------------------

describe("callBackend - detached spawn option", () => {
  test("backend is spawned with detached:true (own pgrp leader)", async () => {
    let receivedOptions: Parameters<SpawnFn>[1] | undefined
    const spawnFn: SpawnFn = (_argv, options) => {
      receivedOptions = options
      return fakeProc({ exitCode: 0 })
    }
    await callBackend(
      "/plugin",
      binCfg(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      new AbortController().signal,
      { spawnFn, existsFn: () => true, parentExitHook: () => () => {} },
    )
    expect(receivedOptions?.detached).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// killBackend helper
// ---------------------------------------------------------------------------

describe("killBackend", () => {
  test("falls back to proc.kill when pid is missing", () => {
    let killedWith: NodeJS.Signals | number | undefined
    const proc: SpawnedProcess = {
      stdout: null,
      stderr: null,
      exited: Promise.resolve(0),
      kill: (sig) => {
        killedWith = sig
        return true
      },
    }
    killBackend(proc, "SIGTERM")
    expect(killedWith).toBe("SIGTERM")
  })

  test("swallows proc.kill errors silently", () => {
    const proc: SpawnedProcess = {
      stdout: null,
      stderr: null,
      exited: Promise.resolve(0),
      kill: () => {
        throw new Error("ESRCH")
      },
    }
    // Should not throw - the postmortem-recovery story is that we always
    // get to the finally block in callBackend so we can clean up listeners.
    expect(() => killBackend(proc, "SIGTERM")).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// callBackend - outer wall-clock watchdog
// ---------------------------------------------------------------------------

describe("callBackend - outer watchdog", () => {
  test("watchdog fires at (timeoutSec + slack) * 1000 ms and SIGTERMs backend", async () => {
    const timersScheduled: Array<{ ms: number; cb: () => void }> = []
    let nextHandle = 1
    const setTimeoutFn = ((cb: () => void, ms: number) => {
      timersScheduled.push({ ms, cb })
      return nextHandle++ as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    const clearTimeoutFn = (() => {}) as typeof clearTimeout

    let killed = false
    let killSignal: NodeJS.Signals | number | undefined
    const spawnFn: SpawnFn = () => ({
      ...fakeProc({ exitCode: 143, exitDelayMs: 30 }),
      kill: (sig) => {
        killed = true
        killSignal = sig
        return true
      },
    })

    const promise = callBackend(
      "/plugin",
      binCfg(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      new AbortController().signal,
      {
        spawnFn,
        existsFn: () => true,
        parentExitHook: () => () => {},
        setTimeoutFn,
        clearTimeoutFn,
        watchdogSlackSec: 5,
      },
    )

    // The outer-watchdog timer is the FIRST one scheduled (before any
    // escalation timer, which only arms on abort).
    const watchdog = timersScheduled[0]
    expect(watchdog).toBeDefined()
    expect(watchdog.ms).toBe(35_000) // (30 + 5) * 1000

    // Manually trigger it - mimics the wall clock elapsing.
    watchdog.cb()
    const result = await promise

    expect(killed).toBe(true)
    expect(killSignal).toBe("SIGTERM")
    expect(result.aborted).toBe(true)
    expect(result.stderr).toContain("outer watchdog fired at 35s")
  })

  test("watchdog uses DEFAULT_WATCHDOG_SLACK_SEC when not overridden", async () => {
    const timersScheduled: Array<{ ms: number }> = []
    const setTimeoutFn = ((_cb: () => void, ms: number) => {
      timersScheduled.push({ ms })
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    const spawnFn: SpawnFn = () => fakeProc({ exitCode: 0 })

    await callBackend(
      "/plugin",
      binCfg(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      new AbortController().signal,
      {
        spawnFn,
        existsFn: () => true,
        parentExitHook: () => () => {},
        setTimeoutFn,
        clearTimeoutFn: () => {},
      },
    )

    expect(timersScheduled[0].ms).toBe((30 + DEFAULT_WATCHDOG_SLACK_SEC) * 1000)
  })

  test("watchdog does NOT fire on a fast-exiting backend", async () => {
    let cleared = false
    const setTimeoutFn = ((_cb: () => void, _ms: number) => {
      return 42 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    const clearTimeoutFn = ((handle: ReturnType<typeof setTimeout>) => {
      if ((handle as unknown as number) === 42) cleared = true
    }) as typeof clearTimeout

    const result = await callBackend(
      "/plugin",
      binCfg(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      new AbortController().signal,
      {
        spawnFn: () => fakeProc({ exitCode: 0, stdout: "ok" }),
        existsFn: () => true,
        parentExitHook: () => () => {},
        setTimeoutFn,
        clearTimeoutFn,
      },
    )

    expect(cleared).toBe(true) // watchdog cleanly cancelled in the finally
    expect(result.ok).toBe(true)
    expect(result.aborted).toBeUndefined()
    expect(result.stderr).not.toContain("outer watchdog")
  })
})

// ---------------------------------------------------------------------------
// callBackend - parent-exit hook
// ---------------------------------------------------------------------------

describe("callBackend - parent-exit hook", () => {
  test("registers a hook and unsubscribes in the finally", async () => {
    let registered = false
    let unsubscribed = false
    const parentExitHook = (_cb: () => void) => {
      registered = true
      return () => {
        unsubscribed = true
      }
    }

    await callBackend(
      "/plugin",
      binCfg(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      new AbortController().signal,
      {
        spawnFn: () => fakeProc({ exitCode: 0 }),
        existsFn: () => true,
        parentExitHook,
      },
    )

    expect(registered).toBe(true)
    expect(unsubscribed).toBe(true)
  })

  test("parent-exit hook SIGKILLs the backend (single-pid fallback)", async () => {
    let onExit: (() => void) | undefined
    const parentExitHook = (cb: () => void) => {
      onExit = cb
      return () => {}
    }

    let killSignal: NodeJS.Signals | number | undefined
    const spawnFn: SpawnFn = () => ({
      ...fakeProc({ exitCode: 0, exitDelayMs: 20 }),
      kill: (sig) => {
        killSignal = sig
        return true
      },
    })

    const promise = callBackend(
      "/plugin",
      binCfg(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      new AbortController().signal,
      { spawnFn, existsFn: () => true, parentExitHook },
    )

    // Simulate the parent shutting down while the backend is in-flight.
    queueMicrotask(() => onExit?.())
    await promise

    expect(killSignal).toBe("SIGKILL")
  })

  test("parent-exit hook errors are swallowed (default hook)", () => {
    // Smoke: defaultParentExitHook returns an unsubscribe that doesn't throw
    // even if the hook closure throws.
    const unsub = defaultParentExitHook(() => {
      throw new Error("boom")
    })
    expect(() => unsub()).not.toThrow()
  })

  test("default hook subscribes to exit + SIGINT + SIGTERM + SIGHUP", () => {
    // We can't easily emit real signals in a test, but we can confirm that
    // the listener count delta is 4 (one per event) and reverts on unsubscribe.
    const before = {
      exit: process.listenerCount("exit"),
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
      sighup: process.listenerCount("SIGHUP"),
    }
    const unsub = defaultParentExitHook(() => {})
    expect(process.listenerCount("exit")).toBe(before.exit + 1)
    expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1)
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1)
    expect(process.listenerCount("SIGHUP")).toBe(before.sighup + 1)
    unsub()
    expect(process.listenerCount("exit")).toBe(before.exit)
    expect(process.listenerCount("SIGINT")).toBe(before.sigint)
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm)
    expect(process.listenerCount("SIGHUP")).toBe(before.sighup)
  })
})

// ---------------------------------------------------------------------------
// buildBackendEnv - storageDir (persistence)
// ---------------------------------------------------------------------------

describe("buildBackendEnv - storageDir", () => {
  test("MA_FETCH_STORAGE_DIR set when input provides storageDir", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      {
        url: "https://x",
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
        storageDir: "/home/me/.minimal-agent/sessions/fetch/twitter",
      },
      {},
    )
    expect(env.MA_FETCH_STORAGE_DIR).toBe("/home/me/.minimal-agent/sessions/fetch/twitter")
  })

  test("MA_FETCH_STORAGE_DIR absent when input omits storageDir", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      {},
    )
    expect(env).not.toHaveProperty("MA_FETCH_STORAGE_DIR")
  })

  test("empty-string storageDir is NOT forwarded", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      {
        url: "https://x",
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
        storageDir: "",
      },
      {},
    )
    expect(env).not.toHaveProperty("MA_FETCH_STORAGE_DIR")
  })

  test("storageDir is independent of MA_FETCH_USER_AGENT / PROXY", () => {
    const cfg = { ...defaultConfig(), userAgent: "UA/1", proxy: "http://p" }
    const env = buildBackendEnv(
      cfg,
      {
        url: "https://x",
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
        storageDir: "/abs/dir",
      },
      {},
    )
    expect(env.MA_FETCH_USER_AGENT).toBe("UA/1")
    expect(env.MA_FETCH_PROXY).toBe("http://p")
    expect(env.MA_FETCH_STORAGE_DIR).toBe("/abs/dir")
  })
})
