import { describe, expect, test } from "bun:test"
import type { BackendDeps, SpawnFn, SpawnedProcess } from "../lib/backend.ts"
import { defaultConfig, type FetchConfig } from "../lib/config.ts"
import type { TUIContext, TUIResult } from "../lib/types.ts"
import handler, {
  buildDisplayBody,
  buildDisplayFooter,
  formatBytes,
  mergeInputs,
  runWithDeps,
  validateInput,
} from "./fetch.ts"

// ---------------------------------------------------------------------------
// validateInput
// ---------------------------------------------------------------------------

describe("validateInput - url", () => {
  test("rejects missing url", () => {
    const v = validateInput({})
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toMatch(/url/)
  })

  test("rejects non-string url", () => {
    expect(validateInput({ url: 42 }).ok).toBe(false)
    expect(validateInput({ url: null }).ok).toBe(false)
    expect(validateInput({ url: [] }).ok).toBe(false)
  })

  test("rejects whitespace-only url", () => {
    expect(validateInput({ url: "   " }).ok).toBe(false)
  })

  test("rejects non-http(s) schemes", () => {
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ftp://example.com",
      "data:text/html,<h1>x</h1>",
      "/relative/path",
      "example.com",
    ]) {
      const v = validateInput({ url: bad })
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.error).toMatch(/http/)
    }
  })

  test("accepts http and https", () => {
    expect(validateInput({ url: "http://example.com" }).ok).toBe(true)
    expect(validateInput({ url: "https://example.com" }).ok).toBe(true)
    expect(validateInput({ url: "HTTPS://example.com" }).ok).toBe(true)
  })

  test("trims surrounding whitespace", () => {
    const v = validateInput({ url: "  https://example.com  " })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.url).toBe("https://example.com")
  })

  test("rejects very long url", () => {
    const v = validateInput({ url: `https://example.com/${"a".repeat(5000)}` })
    expect(v.ok).toBe(false)
  })
})

describe("validateInput - format", () => {
  test("accepts each valid format", () => {
    for (const f of ["markdown", "text", "html", "links", "original"]) {
      const v = validateInput({ url: "https://x", format: f })
      expect(v.ok).toBe(true)
      if (v.ok) expect(v.value.format).toBe(f as never)
    }
  })

  test("rejects invalid format", () => {
    const v = validateInput({ url: "https://x", format: "pdf" })
    expect(v.ok).toBe(false)
  })

  test("undefined format leaves value.format undefined", () => {
    const v = validateInput({ url: "https://x" })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.format).toBeUndefined()
  })
})

describe("validateInput - wait_until", () => {
  test("accepts each valid value", () => {
    for (const w of ["load", "domcontentloaded", "networkidle0"]) {
      const v = validateInput({ url: "https://x", wait_until: w })
      expect(v.ok).toBe(true)
    }
  })

  test("rejects invalid value", () => {
    const v = validateInput({ url: "https://x", wait_until: "ready" })
    expect(v.ok).toBe(false)
  })
})

describe("validateInput - timeout_sec", () => {
  test("accepts integer in [1,120]", () => {
    const v = validateInput({ url: "https://x", timeout_sec: 60 })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.timeoutSec).toBe(60)
  })

  test("floors fractional", () => {
    const v = validateInput({ url: "https://x", timeout_sec: 30.7 })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.timeoutSec).toBe(30)
  })

  test("rejects out-of-range", () => {
    expect(validateInput({ url: "https://x", timeout_sec: 0 }).ok).toBe(false)
    expect(validateInput({ url: "https://x", timeout_sec: 121 }).ok).toBe(false)
    expect(validateInput({ url: "https://x", timeout_sec: -5 }).ok).toBe(false)
  })

  test("rejects non-number", () => {
    expect(validateInput({ url: "https://x", timeout_sec: "30" }).ok).toBe(false)
  })
})

describe("validateInput - selector and eval", () => {
  test("selector trimmed and stored", () => {
    const v = validateInput({ url: "https://x", selector: "  main  " })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.selector).toBe("main")
  })

  test("empty selector is normalized to undefined", () => {
    const v = validateInput({ url: "https://x", selector: "   " })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.selector).toBeUndefined()
  })

  test("eval preserves leading/trailing whitespace (JS may need it)", () => {
    const v = validateInput({ url: "https://x", eval: "  return 1+2  " })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.evalExpr).toBe("  return 1+2  ")
  })

  test("empty-string eval normalizes to undefined", () => {
    const v = validateInput({ url: "https://x", eval: "" })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.evalExpr).toBeUndefined()
  })

  test("non-string selector / eval rejected", () => {
    expect(validateInput({ url: "https://x", selector: 42 }).ok).toBe(false)
    expect(validateInput({ url: "https://x", eval: {} }).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// mergeInputs
// ---------------------------------------------------------------------------

describe("mergeInputs", () => {
  test("config defaults fill in unset input fields", () => {
    const cfg = defaultConfig()
    const merged = mergeInputs({ url: "https://x" }, cfg)
    expect(merged.format).toBe("markdown")
    expect(merged.waitUntil).toBe("load")
    expect(merged.timeoutSec).toBe(30)
  })

  test("input overrides config defaults", () => {
    const cfg: FetchConfig = {
      ...defaultConfig(),
      defaults: { format: "markdown", waitUntil: "load", timeoutSec: 30 },
    }
    const merged = mergeInputs(
      { url: "https://x", format: "text", waitUntil: "networkidle0", timeoutSec: 60 },
      cfg,
    )
    expect(merged.format).toBe("text")
    expect(merged.waitUntil).toBe("networkidle0")
    expect(merged.timeoutSec).toBe(60)
  })

  test("selector and evalExpr passed through", () => {
    const merged = mergeInputs(
      { url: "https://x", selector: "main", evalExpr: "document.title" },
      defaultConfig(),
    )
    expect(merged.selector).toBe("main")
    expect(merged.evalExpr).toBe("document.title")
  })
})

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

describe("formatBytes", () => {
  test("bytes under 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1023)).toBe("1023 B")
  })

  test("KB range", () => {
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(13 * 1024)).toBe("13.0 KB")
    expect(formatBytes(13_200)).toBe("12.9 KB")
  })

  test("MB range", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.00 MB")
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.50 MB")
  })
})

describe("buildDisplayBody", () => {
  test("returns first N lines, no gutter (agent adds it)", () => {
    const content = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn"
    const body = buildDisplayBody(content, 5)
    expect(body).toBe("a\nb\nc\nd\ne")
  })

  test("drops a single trailing empty line", () => {
    const body = buildDisplayBody("a\nb\nc\n", 12)
    expect(body).toBe("a\nb\nc")
  })

  test("clamps per-line width with an ellipsis", () => {
    const long = "x".repeat(500)
    const body = buildDisplayBody(long, 1)
    expect(body.endsWith("…")).toBe(true)
    expect(body.length).toBeLessThanOrEqual(301)
  })

  test("(empty response) sentinel when content empty", () => {
    const body = buildDisplayBody("", 12)
    expect(body).toContain("(empty response)")
  })
})

describe("buildDisplayFooter", () => {
  test("contains format, size, line count, backend", () => {
    const footer = buildDisplayFooter({
      format: "markdown",
      size: 13_200,
      lineCount: 350,
      backend: "obscura.ts",
    })
    expect(footer).toContain("markdown")
    expect(footer).toContain("12.9 KB")
    expect(footer).toContain("350 lines")
    expect(footer).toContain("obscura.ts")
  })

  test("includes 'preview truncated' marker when set", () => {
    const footer = buildDisplayFooter({
      format: "markdown",
      size: 13_200,
      lineCount: 350,
      backend: "obscura.ts",
      truncated: true,
    })
    expect(footer).toContain("preview truncated")
  })
})

// ---------------------------------------------------------------------------
// runWithDeps - full handler with fake backend
// ---------------------------------------------------------------------------

function fakeProc(opts: {
  stdout?: string
  stderr?: string
  exitCode?: number
}): SpawnedProcess {
  const enc = new TextEncoder()
  const mkStream = (s: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (s.length > 0) controller.enqueue(enc.encode(s))
        controller.close()
      },
    })
  return {
    stdout: mkStream(opts.stdout ?? ""),
    stderr: mkStream(opts.stderr ?? ""),
    exited: Promise.resolve(opts.exitCode ?? 0),
    kill: () => true,
  }
}

function fakeCtx(input: Record<string, unknown>): TUIContext {
  return {
    trigger: { type: "tool", name: "Fetch", input },
    packageDir: "/plugin",
    cwd: "/cwd",
    env: {},
    abort: new AbortController().signal,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  }
}

function expectToolResult(r: TUIResult): asserts r is Extract<TUIResult, { kind: "tool_result" }> {
  expect(r.kind).toBe("tool_result")
}

describe("runWithDeps - happy path", () => {
  test("success: content = stdout, is_error unset, display populated", async () => {
    const spawnFn: SpawnFn = () =>
      fakeProc({
        stdout: "line1\nline2\nline3\n",
        stderr: "",
        exitCode: 0,
      })
    const ctx = fakeCtx({ url: "https://example.com" })
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      {
        url: "https://example.com",
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
      },
      { spawnFn, existsFn: () => true },
    )
    expectToolResult(r)
    expect(r.is_error).toBeUndefined()
    expect(r.content).toBe("line1\nline2\nline3\n")
    expect(r.displayHeader).toBe("https://example.com")
    expect(r.display).toContain("line1")
    expect(r.displayFooter).toContain("markdown")
    expect(r.displayFooter).toContain("3 lines")
    expect(r.displayFooter).toContain("obscura.ts")
  })

  test("preview is truncated marker fires when line count > PREVIEW_LINES", async () => {
    const stdout = Array.from({ length: 50 }, (_, i) => `L${i}`).join("\n")
    const spawnFn: SpawnFn = () => fakeProc({ stdout, exitCode: 0 })
    const ctx = fakeCtx({ url: "https://example.com" })
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { spawnFn, existsFn: () => true },
    )
    expectToolResult(r)
    expect(r.displayFooter).toContain("preview truncated")
    expect(r.displayFooter).toContain("50 lines")
  })
})

describe("runWithDeps - error paths", () => {
  test("missing backend script", async () => {
    const spawnFn: SpawnFn = () => fakeProc({})
    const ctx = fakeCtx({ url: "https://example.com" })
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { spawnFn, existsFn: () => false },
    )
    expectToolResult(r)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("backend script not found")
    expect(r.displayHeader).toContain("backend missing")
  })

  test("backend exits non-zero: content includes exit code and stderr tail", async () => {
    const spawnFn: SpawnFn = () =>
      fakeProc({ stdout: "", stderr: "navigation timed out", exitCode: 1 })
    const ctx = fakeCtx({ url: "https://example.com" })
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { spawnFn, existsFn: () => true },
    )
    expectToolResult(r)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("exited with code 1")
    expect(r.content).toContain("navigation timed out")
  })

  test("abort: returns is_error with aborted display", async () => {
    let killed = false
    const ctrl = new AbortController()
    const spawnFn: SpawnFn = () => ({
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          c.close()
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close()
        },
      }),
      exited: new Promise<number>((res) => setTimeout(() => res(143), 50)),
      kill: () => {
        killed = true
        return true
      },
    })
    const ctx = { ...fakeCtx({ url: "https://example.com" }), abort: ctrl.signal }
    const promise = runWithDeps(
      ctx,
      defaultConfig(),
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { spawnFn, existsFn: () => true },
    )
    queueMicrotask(() => ctrl.abort())
    const r = await promise
    expectToolResult(r)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("aborted")
    expect(killed).toBe(true)
  })
})

describe("handler default export - input validation", () => {
  test("returns is_error on invalid url before invoking backend", async () => {
    const ctx = fakeCtx({ url: "not-a-url" })
    const r = await handler(ctx)
    expectToolResult(r)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("http")
  })

  test("returns is_error on missing url", async () => {
    const ctx = fakeCtx({})
    const r = await handler(ctx)
    expectToolResult(r)
    expect(r.is_error).toBe(true)
  })

  test("wrong trigger type returns is_error", async () => {
    const ctx: TUIContext = {
      ...fakeCtx({}),
      trigger: { type: "inline_tag", name: "x" } as TUIContext["trigger"],
    }
    const r = await handler(ctx)
    expectToolResult(r)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("wrong trigger")
  })
})
