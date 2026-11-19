/**
 * `Fetch` handler: cleanup of style/script blocks and of `eval` value results.
 * Split from `fetch.run.test.ts` (file size limit).
 *
 * @module handlers/fetch.cleanup.test
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import type { SpawnedProcess, SpawnFn } from "../lib/backend.ts"
import { defaultConfig } from "../lib/config.ts"
import type { TUIContext, TUIResult } from "../lib/types.ts"

import { runWithDeps } from "./fetch.ts"

// The fail-closed binary precheck reads MINIMAL_AGENT_BIN_DIR. See fetch.run.test.ts.
const SAVED_BIN_DIR = process.env.MINIMAL_AGENT_BIN_DIR
beforeAll(() => {
  process.env.MINIMAL_AGENT_BIN_DIR = "/managed/bin"
})
afterAll(() => {
  if (SAVED_BIN_DIR === undefined) delete process.env.MINIMAL_AGENT_BIN_DIR
  else process.env.MINIMAL_AGENT_BIN_DIR = SAVED_BIN_DIR
})

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

describe("runWithDeps - style and script blocks become stubs", () => {
  const css = `body{color:red}${"a{margin:0}\n".repeat(60)}`
  const js = `var x=1;${"function f(){return 1}\n".repeat(60)}`
  const page = `<html><head><style>${css}</style><script>${js}</script></head><body><p>hi</p></body></html>`

  async function run(format: "markdown" | "html" | "original", stdout: string) {
    const spawnFn: SpawnFn = () => fakeProc({ stdout, exitCode: 0 })
    const r = await runWithDeps(
      fakeCtx({ url: "https://example.com" }),
      defaultConfig(),
      { url: "https://example.com", format, waitUntil: "load", timeoutSec: 30 },
      { spawnFn, existsFn: () => true },
    )
    expectToolResult(r)
    return r.content
  }

  for (const format of ["html", "original"] as const) {
    test(`${format}: both blocks are replaced, the body text stays`, async () => {
      const out = await run(format, page)
      expect(out).toContain('kind="style_block"')
      expect(out).toContain('kind="script_block"')
      expect(out).toContain("<p>hi</p>")
      expect(out).not.toContain("margin:0")
    })
  }

  test("markdown: a block the converter left in the text is replaced", async () => {
    const out = await run("markdown", `# Title\n\n<style>${css}</style>\n\nBody`)
    expect(out).toContain('kind="style_block"')
    expect(out).toContain("# Title")
    expect(out).toContain("Body")
  })

  test("markdown: a <script> in a code fence is a code sample and stays", async () => {
    const sample = `\`\`\`html\n<script>${js}</script>\n\`\`\``
    const out = await run("markdown", `Use this:\n\n${sample}\n`)
    expect(out).toContain(`<script>${js}</script>`)
    expect(out).not.toContain("script_block")
  })
})

describe("runWithDeps - eval value results are data, not a page", () => {
  const value = JSON.stringify([
    "Two  spaces   here",
    `<script>${"x".repeat(300)}</script>`,
    "  lead",
  ])

  async function runEval(evalMode: "value" | "page") {
    const spawnFn: SpawnFn = () => fakeProc({ stdout: value, exitCode: 0 })
    const r = await runWithDeps(
      fakeCtx({ url: "https://example.com" }),
      defaultConfig(),
      {
        url: "https://example.com",
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
        evalExpr: "1",
        evalMode,
      },
      { spawnFn, existsFn: () => true },
    )
    expectToolResult(r)
    return r
  }

  test("value mode: the JSON is not squeezed and no block is replaced", async () => {
    const r = await runEval("value")
    expect(r.content).toBe(value)
  })

  test("value mode: the footer says value, not the format", async () => {
    const r = await runEval("value")
    expect(r.displayFooter).toContain("value")
    expect(r.displayFooter).not.toContain("markdown")
  })

  test("page mode: the result is a page and is cleaned as one", async () => {
    const r = await runEval("page")
    expect(r.content).toContain("Two spaces here")
    expect(r.displayFooter).toContain("markdown")
  })
})
