import { describe, expect, test } from "bun:test"

import type { SpawnedProcess, SpawnFn } from "../lib/backend.ts"
import { defaultConfig, type SpeakConfig } from "../lib/config.ts"
import { SpeechRegistry } from "../lib/registry.ts"
import type { TUIContext } from "../lib/types.ts"

import { type ParsedSpeakInput, runWithDeps, speakContent, validateInput } from "./speak.ts"

// ---------------------------------------------------------------------------
// validateInput
// ---------------------------------------------------------------------------

describe("validateInput", () => {
  const cfg = defaultConfig()

  test("rejects missing / non-string text", () => {
    expect(validateInput({}, cfg).ok).toBe(false)
    expect(validateInput({ text: 42 }, cfg).ok).toBe(false)
    expect(validateInput({ text: null }, cfg).ok).toBe(false)
  })

  test("rejects empty / whitespace-only text", () => {
    expect(validateInput({ text: "" }, cfg).ok).toBe(false)
    expect(validateInput({ text: "   \n\t" }, cfg).ok).toBe(false)
  })

  test("accepts normal text with default wait=false", () => {
    const v = validateInput({ text: "hello" }, cfg)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.value.text).toBe("hello")
      expect(v.value.wait).toBe(false)
    }
  })

  test("honors wait=true", () => {
    const v = validateInput({ text: "hi", wait: true }, cfg)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.wait).toBe(true)
  })

  test("rejects non-boolean wait", () => {
    expect(validateInput({ text: "hi", wait: "yes" }, cfg).ok).toBe(false)
  })

  test("enforces the maxChars cap", () => {
    const small: SpeakConfig = { ...cfg, defaults: { ...cfg.defaults, maxChars: 5 } }
    const v = validateInput({ text: "way too long" }, small)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toMatch(/limit is 5/)
  })

  test("does NOT trim the text it passes through (preserves intended pauses)", () => {
    const v = validateInput({ text: "  spaced out  " }, cfg)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.text).toBe("  spaced out  ")
  })
})

// ---------------------------------------------------------------------------
// runWithDeps - spawn + register
// ---------------------------------------------------------------------------

function ctx(input: Record<string, unknown>): TUIContext {
  return {
    trigger: { type: "tool", name: "Speak", input },
    packageDir: "/pkg",
    cwd: "/cwd",
    env: {},
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
  }
}

interface FakeProc extends SpawnedProcess {
  resolveExit(code: number): void
}

function makeFakeProc(over: Partial<SpawnedProcess> = {}): FakeProc {
  let resolve!: (code: number) => void
  const exited = new Promise<number>((r) => {
    resolve = r
  })
  return {
    pid: 9001,
    stdin: { write() {}, end() {} },
    stderr: null,
    exited,
    kill: () => true,
    resolveExit: (code: number) => resolve(code),
    ...over,
  } as FakeProc
}

const noHook = { parentExitHook: () => () => {} }

function input(over: Partial<ParsedSpeakInput> = {}): ParsedSpeakInput {
  return { text: "hello there", wait: false, ...over }
}

describe("runWithDeps - background (wait=false)", () => {
  test("returns immediately with a speaking job handle", async () => {
    const reg = new SpeechRegistry()
    const proc = makeFakeProc()
    const spawnFn: SpawnFn = () => proc
    const res = await runWithDeps(ctx({}), defaultConfig(), input(), reg, {
      existsFn: () => true,
      spawnFn,
      ...noHook,
    })
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") {
      expect(res.is_error).toBeUndefined()
      expect(res.content).toMatch(/job s1/)
      expect(res.content).toMatch(/background/)
    }
    expect(reg.get("s1")?.state).toBe("speaking")
    expect(reg.get("s1")?.pid).toBe(9001)
  })

  test("reaper marks the job done when the backend exits 0", async () => {
    const reg = new SpeechRegistry()
    const proc = makeFakeProc()
    await runWithDeps(ctx({}), defaultConfig(), input(), reg, {
      existsFn: () => true,
      spawnFn: () => proc,
      ...noHook,
    })
    expect(reg.get("s1")?.state).toBe("speaking")
    proc.resolveExit(0)
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 5))
    expect(reg.get("s1")?.state).toBe("done")
  })

  test("reaper marks the job failed on a non-zero exit", async () => {
    const reg = new SpeechRegistry()
    const proc = makeFakeProc({
      stderr: streamOf("say: command not found"),
    })
    await runWithDeps(ctx({}), defaultConfig(), input(), reg, {
      existsFn: () => true,
      spawnFn: () => proc,
      ...noHook,
    })
    proc.resolveExit(127)
    await new Promise((r) => setTimeout(r, 5))
    const job = reg.get("s1")
    expect(job?.state).toBe("failed")
    expect(job?.exitCode).toBe(127)
    // Failure reason is backend-agnostic, no raw stderr leak.
    expect(job?.failureReason).not.toMatch(/command not found/)
  })
})

describe("runWithDeps - misconfiguration", () => {
  test("missing backend script → engine-unavailable error, no job", async () => {
    const reg = new SpeechRegistry()
    const res = await runWithDeps(ctx({}), defaultConfig(), input(), reg, {
      existsFn: () => false,
    })
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") {
      expect(res.is_error).toBe(true)
      expect(res.content).toMatch(/unavailable/)
    }
    expect(reg.size()).toBe(0)
  })

  test("spawn failure → backend-agnostic error", async () => {
    const reg = new SpeechRegistry()
    const res = await runWithDeps(ctx({}), defaultConfig(), input(), reg, {
      existsFn: () => true,
      spawnFn: () => {
        throw new Error("bun missing")
      },
    })
    if (res.kind === "tool_result") {
      expect(res.is_error).toBe(true)
      expect(res.content).not.toMatch(/bun missing/)
    }
  })
})

describe("runWithDeps - wait=true", () => {
  test("blocks until the job finishes, then reports done", async () => {
    const reg = new SpeechRegistry()
    const proc = makeFakeProc()
    // Resolve the exit shortly after the call starts awaiting.
    setTimeout(() => proc.resolveExit(0), 5)
    const res = await runWithDeps(ctx({}), defaultConfig(), input({ wait: true }), reg, {
      existsFn: () => true,
      spawnFn: () => proc,
      ...noHook,
    })
    expect(reg.get("s1")?.state).toBe("done")
    if (res.kind === "tool_result") {
      expect(res.content).toMatch(/Done speaking/)
    }
  })

  test("returns when the wait budget elapses, leaving the job speaking", async () => {
    const reg = new SpeechRegistry()
    const proc = makeFakeProc() // never resolves → must hit the timeout
    const cfg: SpeakConfig = {
      ...defaultConfig(),
      defaults: { ...defaultConfig().defaults, waitTimeoutSec: 1 },
    }
    // Use a fake timer that fires immediately so the test doesn't wait 1s.
    const res = await runWithDeps(ctx({}), cfg, input({ wait: true }), reg, {
      existsFn: () => true,
      spawnFn: () => proc,
      ...noHook,
      setTimeoutFn: (cb) => {
        cb()
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeoutFn: () => {},
    })
    // Job still speaking (process never exited).
    expect(reg.get("s1")?.state).toBe("speaking")
    if (res.kind === "tool_result") {
      expect(res.content).toMatch(/job s1/)
    }
  })
})

// ---------------------------------------------------------------------------
// speakContent
// ---------------------------------------------------------------------------

describe("speakContent", () => {
  const base = {
    id: "s3",
    pid: 1,
    backend: "macos-say",
    charCount: 10,
    preview: "x",
    startedAt: 0,
  }

  test("speaking mentions the handle and both follow-up tools", () => {
    const c = speakContent({ ...base, state: "speaking" }, false)
    expect(c).toMatch(/s3/)
    expect(c).toMatch(/SpeakStatus/)
    expect(c).toMatch(/SpeakStop/)
  })

  test("done (waited) confirms full read", () => {
    expect(speakContent({ ...base, state: "done" }, true)).toMatch(/Done speaking/)
  })

  test("failed surfaces the backend-agnostic reason", () => {
    const c = speakContent(
      { ...base, state: "failed", failureReason: "Audio output is unavailable." },
      false,
    )
    expect(c).toMatch(/failed/)
    expect(c).toMatch(/Audio output is unavailable/)
  })

  test("stopped is reported", () => {
    expect(speakContent({ ...base, state: "stopped" }, false)).toMatch(/stopped/)
  })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
