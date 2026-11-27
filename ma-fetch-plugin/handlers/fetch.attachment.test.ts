/**
 * Fetch of an image URL: the body goes to core as a tool attachment. A
 * `binary: true` image and a PDF keep the old `binary-result` paths.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { pluginSideband } from "../../tests/support/sideband.ts"
import type { SpawnedProcess, SpawnFn } from "../lib/backend.ts"
import { defaultConfig } from "../lib/config.ts"
import type { TUIContext, TUIResult } from "../lib/types.ts"

import { runWithDeps } from "./fetch.ts"

const sb = await pluginSideband()

// The fail-closed binary precheck reads MINIMAL_AGENT_BIN_DIR. See fetch.run.test.ts.
const SAVED_BIN_DIR = process.env.MINIMAL_AGENT_BIN_DIR
beforeAll(() => {
  process.env.MINIMAL_AGENT_BIN_DIR = "/managed/bin"
})
afterAll(() => {
  if (SAVED_BIN_DIR === undefined) delete process.env.MINIMAL_AGENT_BIN_DIR
  else process.env.MINIMAL_AGENT_BIN_DIR = SAVED_BIN_DIR
})

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
    sideband: sb,
  }
}

function expectToolResult(r: TUIResult): asserts r is Extract<TUIResult, { kind: "tool_result" }> {
  expect(r.kind).toBe("tool_result")
}

describe("runWithDeps - image attachment", () => {
  // PNG magic, then a NUL. Bytes >= 0x80 are not valid UTF-8 alone, so the
  // fake process gets the raw bytes, not a string.
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3])
  const url = "https://example.com/logo.png"

  function bytesProc(bytes: Uint8Array): SpawnedProcess {
    const mk = (b: Uint8Array) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (b.length > 0) controller.enqueue(b)
          controller.close()
        },
      })
    return {
      stdout: mk(bytes),
      stderr: mk(new Uint8Array()),
      exited: Promise.resolve(0),
      kill: () => true,
    }
  }

  async function runImage(binary: boolean, home: string, sid: string) {
    const spawnFn: SpawnFn = () => bytesProc(pngBytes)
    const ctx = fakeCtx({ url, format: "original", ...(binary ? { binary: true } : {}) })
    ctx.trigger = { ...ctx.trigger, tool_use_id: "toolu_img" } as TUIContext["trigger"]
    ctx.env = { ...ctx.env, MINIMAL_AGENT_HOME: home, MINIMAL_AGENT_SESSION_ID: sid }
    const r = await runWithDeps(
      ctx,
      defaultConfig(),
      { url, format: "original", waitUntil: "load", timeoutSec: 30 },
      { spawnFn, existsFn: () => true },
      "basic",
      binary,
    )
    expectToolResult(r)
    return r
  }

  test("PNG body gives an attachment with the same bytes and mime, and writes no .bin", async () => {
    const { existsSync, mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const home = mkdtempSync(join(tmpdir(), "ma-fetch-png-"))
    try {
      const r = await runImage(false, home, "img-sid")
      expect(r.attachments).toHaveLength(1)
      const att = r.attachments![0]!
      expect(att.mimeType).toBe("image/png")
      expect(att.label).toBe(url)
      expect(Array.from(att.bytes)).toEqual(Array.from(pngBytes))
      expect(r.content).toContain(url)
      expect(r.content).toContain("image/png")
      expect(sb.has(r.content, { kinds: ["binary-result"] })).toBe(false)
      expect(r.content).not.toContain(Buffer.from(pngBytes).toString("base64"))
      expect(existsSync(join(home, "sessions", "img-sid.blobs", "toolu_img.bin"))).toBe(false)
      expect(existsSync(join(home, "sessions", "img-sid.blobs"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("binary=true PNG keeps the base64 path and gives no attachment", async () => {
    const { existsSync, mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const home = mkdtempSync(join(tmpdir(), "ma-fetch-png2-"))
    try {
      const r = await runImage(true, home, "img-sid2")
      expect(r.attachments).toBeUndefined()
      const [tag] = sb.find(r.content, { kinds: ["binary-result"] })
      expect(tag?.attrs.encoding).toBe("base64")
      expect(r.content).toContain(Buffer.from(pngBytes).toString("base64"))
      expect(existsSync(join(home, "sessions", "img-sid2.blobs", "toolu_img.bin"))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("PDF body keeps the withheld path: no attachment, a saved .bin", async () => {
    const { existsSync, mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const home = mkdtempSync(join(tmpdir(), "ma-fetch-pdf3-"))
    try {
      const pdf = new TextEncoder().encode("%PDF-1.6\nbody")
      const spawnFn: SpawnFn = () => bytesProc(pdf)
      const ctx = fakeCtx({ url: "https://example.com/a.pdf", format: "original" })
      ctx.trigger = { ...ctx.trigger, tool_use_id: "toolu_pdf" } as TUIContext["trigger"]
      ctx.env = { ...ctx.env, MINIMAL_AGENT_HOME: home, MINIMAL_AGENT_SESSION_ID: "pdf-sid" }
      const r = await runWithDeps(
        ctx,
        defaultConfig(),
        { url: "https://example.com/a.pdf", format: "original", waitUntil: "load", timeoutSec: 30 },
        { spawnFn, existsFn: () => true },
        "basic",
        false,
      )
      expectToolResult(r)
      expect(r.attachments).toBeUndefined()
      expect(sb.has(r.content, { kinds: ["binary-result"] })).toBe(true)
      expect(r.content).toContain("did not put the binary body")
      expect(existsSync(join(home, "sessions", "pdf-sid.blobs", "toolu_pdf.bin"))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
