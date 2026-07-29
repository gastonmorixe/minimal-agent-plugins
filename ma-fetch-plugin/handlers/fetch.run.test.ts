import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import type { SpawnedProcess, SpawnFn } from "../lib/backend.ts"
import { defaultConfig } from "../lib/config.ts"
import type { TUIContext, TUIResult } from "../lib/types.ts"

import handler, { runWithDeps } from "./fetch.ts"

// The dispatcher's fail-closed binary precheck (lib/backend.ts:resolveBackendBin)
// reads MINIMAL_AGENT_BIN_DIR from process.env and confirms the candidate via
// the injected existsFn. The runWithDeps tests below inject `existsFn: () =>
// true` to simulate "script + binary present", so we advertise a managed bin
// dir here to match what the host does in production. Without it, callBackend
// would correctly refuse to spawn (binUnavailable) and these spawn-path tests
// would see an engine-unavailable error instead of the fake backend's output.
const SAVED_BIN_DIR = process.env.MINIMAL_AGENT_BIN_DIR
beforeAll(() => {
  process.env.MINIMAL_AGENT_BIN_DIR = "/managed/bin"
})
afterAll(() => {
  if (SAVED_BIN_DIR === undefined) delete process.env.MINIMAL_AGENT_BIN_DIR
  else process.env.MINIMAL_AGENT_BIN_DIR = SAVED_BIN_DIR
})

// ---------------------------------------------------------------------------
// runWithDeps - full handler with fake backend
// ---------------------------------------------------------------------------

function fakeProc(opts: { stdout?: string; stderr?: string; exitCode?: number }): SpawnedProcess {
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

describe("runWithDeps - persistent routing", () => {
  test("uses persistent transport only for eligible obscura rendered calls", async () => {
    let persistentCalls = 0
    let oneShotCalls = 0
    const spawnFn: SpawnFn = () => {
      oneShotCalls++
      return fakeProc({ stdout: "one-shot", exitCode: 0 })
    }
    const persistentCall = async () => {
      persistentCalls++
      return {
        kind: "result" as const,
        workerPid: 777,
        result: {
          ok: true,
          exitCode: 0,
          stdout: "persistent",
          stdoutBytes: new TextEncoder().encode("persistent"),
          stderr: "",
          backend: "obscura.ts",
        },
      }
    }
    const r = await runWithDeps(
      fakeCtx({ url: "https://example.com" }),
      defaultConfig(),
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { persistentCall, spawnFn, existsFn: () => true },
    )
    expectToolResult(r)
    expect(r.content).toBe("persistent")
    expect(r.displayFooter).toContain("worker pid: 777")
    expect(persistentCalls).toBe(1)
    expect(oneShotCalls).toBe(0)
  })

  test("startup fallback and original format preserve one-shot backend", async () => {
    let persistentCalls = 0
    let oneShotCalls = 0
    const spawnFn: SpawnFn = () => {
      oneShotCalls++
      return fakeProc({ stdout: "one-shot", exitCode: 0 })
    }
    const persistentCall = async () => {
      persistentCalls++
      return { kind: "fallback" as const, reason: "unsupported worker protocol" }
    }
    const rendered = await runWithDeps(
      fakeCtx({ url: "https://example.com" }),
      defaultConfig(),
      { url: "https://example.com", format: "text", waitUntil: "load", timeoutSec: 30 },
      { persistentCall, spawnFn, existsFn: () => true },
    )
    const original = await runWithDeps(
      fakeCtx({ url: "https://example.com" }),
      defaultConfig(),
      { url: "https://example.com", format: "original", waitUntil: "load", timeoutSec: 30 },
      { persistentCall, spawnFn, existsFn: () => true },
    )
    expectToolResult(rendered)
    expectToolResult(original)
    expect(rendered.content).toBe("one-shot")
    expect(original.content).toBe("one-shot")
    expect(persistentCalls).toBe(1)
    expect(oneShotCalls).toBe(2)
  })

  test("accessibility never falls back to an incompatible one-shot CLI", async () => {
    let oneShotCalls = 0
    const spawnFn: SpawnFn = () => {
      oneShotCalls++
      return fakeProc({ stdout: "wrong", exitCode: 0 })
    }
    const persistentCall = async () => ({
      kind: "fallback" as const,
      reason: "old worker",
    })
    const r = await runWithDeps(
      fakeCtx({ url: "https://example.com" }),
      defaultConfig(),
      {
        url: "https://example.com",
        format: "accessibility",
        waitUntil: "load",
        timeoutSec: 30,
      },
      { persistentCall, spawnFn, existsFn: () => true },
    )
    expectToolResult(r)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("compatible render worker")
    expect(oneShotCalls).toBe(0)
  })

  test("eval value uses one-shot while eval page remains worker-compatible", async () => {
    let persistentCalls = 0
    let oneShotCalls = 0
    const spawnFn: SpawnFn = () => {
      oneShotCalls++
      return fakeProc({ stdout: "value", exitCode: 0 })
    }
    const persistentCall = async () => {
      persistentCalls++
      return {
        kind: "result" as const,
        result: {
          ok: true,
          exitCode: 0,
          stdout: "page",
          stdoutBytes: new TextEncoder().encode("page"),
          stderr: "",
          backend: "obscura.ts",
        },
      }
    }
    await runWithDeps(
      fakeCtx({ url: "https://example.com" }),
      defaultConfig(),
      {
        url: "https://example.com",
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
        evalExpr: "document.title",
        evalMode: "value",
      },
      { persistentCall, spawnFn, existsFn: () => true },
    )
    await runWithDeps(
      fakeCtx({ url: "https://example.com" }),
      defaultConfig(),
      {
        url: "https://example.com",
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
        evalExpr: "document.title",
        evalMode: "page",
      },
      { persistentCall, spawnFn, existsFn: () => true },
    )
    expect(oneShotCalls).toBe(1)
    expect(persistentCalls).toBe(1)
  })

  test("configured extensions remain eligible for the persistent worker", async () => {
    let persistentCalls = 0
    const config = defaultConfig()
    config.backends.obscura = { ...config.backends.obscura, extensions: ["/ext.zip"] }
    const result = await runWithDeps(
      fakeCtx({ url: "https://example.com" }),
      config,
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      {
        persistentCall: async () => {
          persistentCalls++
          return {
            kind: "result" as const,
            result: {
              ok: true,
              exitCode: 0,
              stdout: "persistent-with-extension",
              stdoutBytes: new TextEncoder().encode("persistent-with-extension"),
              stderr: "",
              backend: "obscura.ts",
            },
          }
        },
        existsFn: () => true,
      },
    )
    expectToolResult(result)
    expect(result.content).toBe("persistent-with-extension")
    expect(persistentCalls).toBe(1)
  })

  test("non-obscura backend and persistent=false stay one-shot", async () => {
    let persistentCalls = 0
    let oneShotCalls = 0
    const spawnFn: SpawnFn = () => {
      oneShotCalls++
      return fakeProc({ stdout: "one-shot", exitCode: 0 })
    }
    const persistentCall = async () => {
      persistentCalls++
      throw new Error("must not run")
    }
    const disabled = defaultConfig()
    disabled.backends.obscura = { persistent: false, bin: "/managed/bin/obscura" }
    await runWithDeps(
      fakeCtx({ url: "https://example.com" }),
      disabled,
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { persistentCall, spawnFn, existsFn: () => true },
    )
    const other = defaultConfig()
    other.backend = "playwright"
    other.backends.playwright = { bin: "/managed/bin/playwright" }
    await runWithDeps(
      fakeCtx({ url: "https://example.com" }),
      other,
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { persistentCall, spawnFn, existsFn: () => true },
    )
    expect(persistentCalls).toBe(0)
    expect(oneShotCalls).toBe(2)
  })
})

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
    // `normalizeMarkdown` strips the trailing newline as part of its
    // "trim trailing blank lines" rule. The pre-normalize stdout was
    // "line1\nline2\nline3\n"; the post-normalize content is the
    // same three lines without the trailing empty line.
    expect(r.content).toBe("line1\nline2\nline3")
    expect(r.displayHeader).toBe("https://example.com")
    expect(r.display).toContain("line1")
    expect(r.displayFooter).toContain("markdown")
    expect(r.displayFooter).toContain("3 lines")
    // Backend-agnostic: nothing in the footer reveals the render engine.
    expect(r.displayFooter?.toLowerCase()).not.toContain("obscura")
    expect(r.displayFooter).not.toContain("via ")
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
    // Generic, backend-agnostic failure. Must not name the engine.
    expect(r.content).toContain("render engine is unavailable")
    expect(r.content.toLowerCase()).not.toContain("obscura")
    expect(r.content).not.toContain(".ts")
    expect(r.displayHeader).toContain("engine-unavailable")
  })

  test("no resolvable binary maps to the same generic engine-unavailable error", async () => {
    // Script EXISTS (existsFn true for the script path) but no managed binary
    // can be resolved: no operator override and no MINIMAL_AGENT_BIN_DIR for
    // this one call. The handler must surface the generic engine-unavailable
    // message, never naming obscura or hinting at a PATH lookup.
    const prev = process.env.MINIMAL_AGENT_BIN_DIR
    process.env.MINIMAL_AGENT_BIN_DIR = ""
    try {
      let spawned = false
      const spawnFn: SpawnFn = () => {
        spawned = true
        return fakeProc({})
      }
      const ctx = fakeCtx({ url: "https://example.com" })
      const r = await runWithDeps(
        ctx,
        defaultConfig(), // no operator override
        { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
        { spawnFn, existsFn: () => true },
      )
      expectToolResult(r)
      expect(r.is_error).toBe(true)
      expect(r.content).toContain("render engine is unavailable")
      expect(r.content.toLowerCase()).not.toContain("obscura")
      expect(r.content.toLowerCase()).not.toContain("path")
      expect(r.displayHeader).toContain("engine-unavailable")
      expect(spawned).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_BIN_DIR
      else process.env.MINIMAL_AGENT_BIN_DIR = prev
    }
  })

  test("classified failure (timeout): clean typed message, no raw stderr, no exit code", async () => {
    const spawnFn: SpawnFn = () =>
      fakeProc({ stdout: "", stderr: "FATAL: navigation timed out after 30s", exitCode: 1 })
    const ctx = fakeCtx({ url: "https://example.com" })
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { spawnFn, existsFn: () => true },
    )
    expectToolResult(r)
    expect(r.is_error).toBe(true)
    // Recognized → clean, typed message. The useful signal (timed out)
    // survives; the raw stderr line does not.
    expect(r.content.toLowerCase()).toContain("timed out")
    expect(r.content).not.toContain("FATAL")
    expect(r.content.toLowerCase()).not.toContain("obscura")
  })

  test("unclassified failure: generic message + opaque ref, raw stderr NOT surfaced", async () => {
    const spawnFn: SpawnFn = () =>
      fakeProc({ stdout: "", stderr: "obscura: kaboom unrecognized at obscura.ts:42", exitCode: 1 })
    const ctx = fakeCtx({ url: "https://example.com" })
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { spawnFn, existsFn: () => true },
    )
    expectToolResult(r)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("could not be fetched")
    expect(r.content).toContain("exit code 1")
    // Opaque correlation id present; no path / file hint and no raw stderr.
    expect(r.content).toMatch(/\[ref: t-[a-z0-9-]+\]/)
    expect(r.content).not.toContain("kaboom")
    expect(r.content.toLowerCase()).not.toContain("obscura")
    expect(r.content).not.toContain(".log")
    expect(r.content).not.toContain("/")
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

  test("watchdog kill is reported as a time-budget timeout, NOT 'aborted by user'", async () => {
    // Regression: the outer wall-clock watchdog set result.aborted=true and the
    // handler hard-coded "aborted by user", lying to the model about a backend
    // wedge. The reason must now travel through and produce a timeout message.
    let exitResolve: (code: number) => void = () => {}
    const exited = new Promise<number>((res) => {
      exitResolve = res
    })
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
      exited,
      pid: 4321,
      // When the watchdog kills, let the process "exit" so callBackend returns.
      kill: () => {
        exitResolve(137)
        return true
      },
    })
    // Fire the very first scheduled timer (the watchdog) synchronously; ignore
    // the later 2s SIGKILL-escalation timer.
    let fired = false
    const setTimeoutFn = (cb: () => void): ReturnType<typeof setTimeout> => {
      if (!fired) {
        fired = true
        cb()
      }
      return 0 as unknown as ReturnType<typeof setTimeout>
    }
    const ctx = fakeCtx({ url: "https://example.com" })
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 5 },
      {
        spawnFn,
        existsFn: () => true,
        setTimeoutFn,
        clearTimeoutFn: () => {},
        parentExitHook: () => () => {},
      },
    )
    expectToolResult(r)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("time budget")
    expect(r.content).not.toContain("aborted by user")
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

describe("runWithDeps - normalizer is format-gated", () => {
  const noisyStdout = "line1\n\n\n\n\nline2\n\n\n\nline3\n\n\n"

  async function runWithFormat(format: "markdown" | "text" | "html" | "links" | "original") {
    const spawnFn: SpawnFn = () => fakeProc({ stdout: noisyStdout, exitCode: 0 })
    const ctx = fakeCtx({ url: "https://example.com" })
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      {
        url: "https://example.com",
        format,
        waitUntil: "load",
        timeoutSec: 30,
      },
      { spawnFn, existsFn: () => true },
    )
    expectToolResult(r)
    return r
  }

  test("markdown: blank runs collapsed", async () => {
    const r = await runWithFormat("markdown")
    expect(r.content).toBe("line1\n\nline2\n\nline3")
  })

  test("text: blank runs collapsed (same as markdown)", async () => {
    const r = await runWithFormat("text")
    expect(r.content).toBe("line1\n\nline2\n\nline3")
  })

  test("html: passthrough (newlines are syntactically meaningful inside <pre>)", async () => {
    const r = await runWithFormat("html")
    expect(r.content).toBe(noisyStdout)
  })

  test("links: passthrough", async () => {
    const r = await runWithFormat("links")
    expect(r.content).toBe(noisyStdout)
  })

  test("original: passthrough for text (raw byte stream from backend)", async () => {
    const r = await runWithFormat("original")
    expect(r.content).toBe(noisyStdout)
  })
})

// ---------------------------------------------------------------------------
// runWithDeps - binary body withheld unless binary=true
// ---------------------------------------------------------------------------

describe("runWithDeps - binary body guard", () => {
  // NUL after the PDF magic so classifyBinaryBytes is decisive even if the
  // rest of the body is printable.
  const pdfStdout = "%PDF-1.6\n" + "x".repeat(80) + "\n" + String.fromCharCode(0, 1, 2, 3, 4)

  test("PDF body is withheld by default (no mojibake in content)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const home = mkdtempSync(join(tmpdir(), "ma-fetch-pdf-"))
    try {
      const spawnFn: SpawnFn = () => fakeProc({ stdout: pdfStdout, exitCode: 0 })
      const ctx = fakeCtx({ url: "https://example.com/spec.pdf", format: "original" })
      ctx.env = { ...ctx.env, MINIMAL_AGENT_HOME: home, MINIMAL_AGENT_SESSION_ID: "test-sid" }
      const r = await runWithDeps(
        ctx,
        defaultConfig(),
        {
          url: "https://example.com/spec.pdf",
          format: "original",
          waitUntil: "load",
          timeoutSec: 30,
        },
        { spawnFn, existsFn: () => true },
        "basic",
        false,
      )
      expectToolResult(r)
      expect(r.content).toContain("<ma::agent::binary-result")
      expect(r.content).toContain("application/pdf")
      expect(r.content).toContain("Binary body withheld")
      expect(r.content).not.toContain("%PDF-1.6\nx")
      expect(r.display ?? "").toMatch(/application\/pdf/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("binary=true inlines small PDF as base64", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const home = mkdtempSync(join(tmpdir(), "ma-fetch-pdf2-"))
    try {
      const small = "%PDF-1.4 small"
      const spawnFn: SpawnFn = () => fakeProc({ stdout: small, exitCode: 0 })
      const ctx = fakeCtx({
        url: "https://example.com/s.pdf",
        format: "original",
        binary: true,
      })
      ctx.env = { ...ctx.env, MINIMAL_AGENT_HOME: home, MINIMAL_AGENT_SESSION_ID: "test-sid2" }
      const r = await runWithDeps(
        ctx,
        defaultConfig(),
        {
          url: "https://example.com/s.pdf",
          format: "original",
          waitUntil: "load",
          timeoutSec: 30,
        },
        { spawnFn, existsFn: () => true },
        "basic",
        true,
      )
      expectToolResult(r)
      expect(r.content).toContain('encoding="base64"')
      expect(r.content).toContain(Buffer.from(small).toString("base64"))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// runWithDeps - cleanup level threading (per-call cleanup override)
// ---------------------------------------------------------------------------

describe("runWithDeps - cleanup level", () => {
  // Bloomberg-shaped fixture: every content line wrapped by a blank line.
  // Basic preserves the blanks (paragraph separators), aggressive drops
  // them all.
  const wrapped = "# Title\n\nBy Author\n\n- [Link 1](#)\n- [Link 2](#)\n\nBody paragraph.\n"

  async function runAt(
    level: "off" | "basic" | "aggressive",
    format: "markdown" | "text" | "html" = "markdown",
  ) {
    const spawnFn: SpawnFn = () => fakeProc({ stdout: wrapped, exitCode: 0 })
    const ctx = fakeCtx({ url: "https://example.com" })
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      { url: "https://example.com", format, waitUntil: "load", timeoutSec: 30 },
      { spawnFn, existsFn: () => true },
      level,
    )
    expectToolResult(r)
    return r
  }

  test("off: content is verbatim stdout (no transform)", async () => {
    const r = await runAt("off")
    expect(r.content).toBe(wrapped)
  })

  test("basic: preserves single blank lines (paragraph separators)", async () => {
    const r = await runAt("basic")
    expect(r.content).toBe(
      "# Title\n\nBy Author\n\n- [Link 1](#)\n- [Link 2](#)\n\nBody paragraph.",
    )
  })

  test("aggressive: drops ALL blank lines", async () => {
    const r = await runAt("aggressive")
    expect(r.content).toBe("# Title\nBy Author\n- [Link 1](#)\n- [Link 2](#)\nBody paragraph.")
  })

  test("aggressive on html: still passthrough (format-gated)", async () => {
    // Cleanup is ONLY applied to markdown/text regardless of level.
    const r = await runAt("aggressive", "html")
    expect(r.content).toBe(wrapped)
  })
})

// ---------------------------------------------------------------------------
// Leak guard: NOTHING the model/transcript sees may name the render engine.
// This is the executable form of the "Fetch is backend-agnostic" contract.
// ---------------------------------------------------------------------------

describe("backend-agnostic leak guard", () => {
  const ENGINE_TOKENS = [/obscura/i, /playwright/i, /\bvia .+\.ts\b/i, /curl-impersonate/i]

  function assertNoEngineLeak(r: TUIResult): void {
    expectToolResult(r)
    const surfaces = [r.content, r.display, r.displayHeader, r.displayFooter].filter(
      (s): s is string => typeof s === "string",
    )
    for (const s of surfaces) {
      for (const re of ENGINE_TOKENS) {
        expect(re.test(s)).toBe(false)
      }
    }
  }

  test("success path surfaces no engine identity", async () => {
    const spawnFn: SpawnFn = () => fakeProc({ stdout: "hello world\n", exitCode: 0 })
    const ctx = fakeCtx({ url: "https://example.com" })
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { spawnFn, existsFn: () => true },
    )
    assertNoEngineLeak(r)
  })

  test("session footer surfaces no engine identity", async () => {
    const spawnFn: SpawnFn = () => fakeProc({ stdout: "ok\n", exitCode: 0 })
    const ctx = fakeCtx({ url: "https://example.com", session: "twitter" })
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      {
        url: "https://example.com",
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
        storageDir: "/root/.minimal-agent/sessions/fetch/twitter",
      },
      { spawnFn, existsFn: () => true },
    )
    assertNoEngineLeak(r)
  })

  test("missing-script path surfaces no engine identity", async () => {
    const spawnFn: SpawnFn = () => fakeProc({})
    const ctx = fakeCtx({ url: "https://example.com" })
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { spawnFn, existsFn: () => false },
    )
    assertNoEngineLeak(r)
  })

  test("unclassified non-zero exit: generic message, no raw stderr, no identity", async () => {
    const spawnFn: SpawnFn = () =>
      fakeProc({ stderr: "obscura: kaboom unrecognized at obscura.ts:42", exitCode: 1 })
    const ctx = fakeCtx({ url: "https://example.com" })
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { spawnFn, existsFn: () => true },
    )
    expectToolResult(r)
    // Raw stderr is never surfaced; only a generic message + opaque ref.
    expect(r.content).not.toContain("kaboom")
    assertNoEngineLeak(r)
  })

  test("classified non-zero exit: clean typed message, no identity", async () => {
    const spawnFn: SpawnFn = () =>
      fakeProc({ stderr: "obscura: navigation timed out at obscura.ts:42", exitCode: 1 })
    const ctx = fakeCtx({ url: "https://example.com" })
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      { url: "https://example.com", format: "markdown", waitUntil: "load", timeoutSec: 30 },
      { spawnFn, existsFn: () => true },
    )
    expectToolResult(r)
    expect(r.content.toLowerCase()).toContain("timed out")
    assertNoEngineLeak(r)
  })
})
