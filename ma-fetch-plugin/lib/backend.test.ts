import { describe, expect, test } from "bun:test"
import {
  buildBackendEnv,
  callBackend,
  resolveBackendPath,
  type SpawnFn,
  type SpawnedProcess,
} from "./backend.ts"
import { defaultConfig, type FetchConfig } from "./config.ts"

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

  test("MA_FETCH_BIN comes from config.backends[backend].bin", () => {
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

  test("config-fields absent when null/missing", () => {
    const env = buildBackendEnv(
      defaultConfig(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      {},
    )
    expect(env).not.toHaveProperty("MA_FETCH_USER_AGENT")
    expect(env).not.toHaveProperty("MA_FETCH_PROXY")
    expect(env).not.toHaveProperty("MA_FETCH_BIN")
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
      ? new Promise<number>((res) =>
          setTimeout(() => res(opts.exitCode ?? 0), opts.exitDelayMs),
        )
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
      defaultConfig(),
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
      defaultConfig(),
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
      defaultConfig(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      new AbortController().signal,
      { spawnFn, existsFn: () => true },
    )
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain("failed to spawn")
    expect(result.stderr).toContain("ENOENT")
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
      defaultConfig(),
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
      defaultConfig(),
      { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      ctrl.signal,
      { spawnFn, existsFn: () => true },
    )
    expect(killed).toBe(true)
    expect(result.aborted).toBe(true)
  })
})
