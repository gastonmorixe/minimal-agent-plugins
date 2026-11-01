/**
 * Headless bytes of the `Fetch` tool (spec S41).
 *
 * The golden file pins the model-facing `content` of each path (invalid
 * input, a page, a long page, a backend error, a binary body), so the S41
 * move of the display palette to `ui/` cannot change model bytes. Without
 * the CLI `ui.setup`, no output field holds an escape byte.
 *
 * Regenerate the golden file only for an intended content change:
 * `UPDATE_GOLDEN=1 bun test handlers/headless-bytes.test.ts`.
 *
 * @module handlers/headless-bytes.test
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import type { SpawnedProcess, SpawnFn } from "../lib/backend.ts"
import { defaultConfig } from "../lib/config.ts"
import { slots } from "../lib/style.ts"
import type { TUIContext, TUIResult } from "../lib/types.ts"

import handler, { runWithDeps } from "./fetch.ts"

const GOLDEN_PATH = join(import.meta.dir, "headless-bytes.golden.json")
const ESC = String.fromCharCode(0x1b)

const SAVED_BIN_DIR = process.env.MINIMAL_AGENT_BIN_DIR
beforeAll(() => {
  // Start from plain slots. Another test file in the same run can install the
  // terminal kit, and the escape-byte check below needs the plain state.
  slots.reset()
  process.env.MINIMAL_AGENT_BIN_DIR = "/managed/bin"
})
afterAll(() => {
  if (SAVED_BIN_DIR === undefined) delete process.env.MINIMAL_AGENT_BIN_DIR
  else process.env.MINIMAL_AGENT_BIN_DIR = SAVED_BIN_DIR
})

function fakeProc(stdout: string, stderr: string, exitCode: number): SpawnedProcess {
  const enc = new TextEncoder()
  const mk = (s: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (s.length > 0) c.enqueue(enc.encode(s))
        c.close()
      },
    })
  return {
    stdout: mk(stdout),
    stderr: mk(stderr),
    exited: Promise.resolve(exitCode),
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

/** Run one one-shot backend call that prints `stdout`. */
async function run(
  stdout: string,
  stderr = "",
  exitCode = 0,
  format = "markdown",
): Promise<TUIResult> {
  const spawnFn: SpawnFn = () => fakeProc(stdout, stderr, exitCode)
  const persistentCall = async () => ({ kind: "fallback" as const, reason: "test" })
  return runWithDeps(
    fakeCtx({ url: "https://example.com/a" }),
    defaultConfig(),
    {
      url: "https://example.com/a",
      format: format as "markdown",
      waitUntil: "load",
      timeoutSec: 30,
    },
    { persistentCall, spawnFn, existsFn: () => true },
  )
}

const LONG = Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(300)}`).join("\n")

async function results(): Promise<Record<string, TUIResult>> {
  return {
    invalid: await handler(fakeCtx({ url: "ftp://nope" })),
    page: await run("# Title\n\n\n\nBody text.\n"),
    long: await run(LONG),
    empty: await run(""),
    backendError: await run("", "navigation failed: net::ERR_NAME_NOT_RESOLVED", 1),
    text: await run("plain words", "", 0, "text"),
  }
}

/** The text fields of a result. */
function fields(r: TUIResult): Record<string, string | boolean | undefined> {
  if (r.kind !== "tool_result") throw new Error(`unexpected result kind ${r.kind}`)
  return {
    content: r.content,
    is_error: r.is_error,
    display: r.display,
    displayHeader: r.displayHeader,
    displayFooter: r.displayFooter,
  }
}

describe("Fetch headless bytes (S41)", () => {
  test("model-facing content matches the golden file", async () => {
    const got: Record<string, unknown> = {}
    for (const [name, r] of Object.entries(await results())) {
      const f = fields(r)
      got[name] = { content: f.content, is_error: f.is_error }
    }
    // The golden file is committed. Write it only on an explicit request, so a
    // missing or deleted golden file fails the test and does not pass silently.
    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(got, null, 2)}\n`)
    }
    if (!existsSync(GOLDEN_PATH)) {
      throw new Error(`golden file missing: ${GOLDEN_PATH}. Set UPDATE_GOLDEN=1 to write it.`)
    }
    expect(got).toEqual(JSON.parse(readFileSync(GOLDEN_PATH, "utf-8")))
  })

  test("no output field holds an escape byte without the CLI ui.setup", async () => {
    for (const [name, r] of Object.entries(await results())) {
      for (const [k, v] of Object.entries(fields(r))) {
        if (typeof v === "string")
          expect({ name, k, esc: v.includes(ESC) }).toEqual({ name, k, esc: false })
      }
    }
  })
})
