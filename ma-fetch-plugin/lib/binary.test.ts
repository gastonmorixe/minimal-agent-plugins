import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import {
  classifyBinaryBytes,
  formatBinaryOptedIn,
  formatBinaryWithheld,
  MAX_INLINE_BINARY_BYTES,
  persistBinaryBody,
  sniffMime,
} from "./binary.ts"

const tempDirs: string[] = []
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describe("sniffMime / classifyBinaryBytes", () => {
  test("PDF", () => {
    const b = new TextEncoder().encode("%PDF-1.6\n%stuff")
    expect(sniffMime(b)).toBe("application/pdf")
    expect(classifyBinaryBytes(b)).toEqual({ binary: true, mime: "application/pdf" })
  })

  test("PNG", () => {
    const b = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(classifyBinaryBytes(b).mime).toBe("image/png")
  })

  test("plain text is not binary", () => {
    const b = new TextEncoder().encode("# Hello\n\nbody\n")
    expect(classifyBinaryBytes(b).binary).toBe(false)
  })

  test("NUL bytes are binary", () => {
    expect(classifyBinaryBytes(Uint8Array.from([1, 2, 0, 3])).binary).toBe(true)
  })
})

describe("formatBinaryWithheld / formatBinaryOptedIn", () => {
  test("withheld emits ma::agent::binary-result without body", () => {
    const msg = formatBinaryWithheld({
      mime: "application/pdf",
      sizeBytes: 1000,
      path: "/tmp/x.bin",
      sha256: "abc",
    })
    expect(msg).toContain("<ma::agent::binary-result")
    expect(msg).toContain('mime="application/pdf"')
    expect(msg).toContain("Binary body withheld")
    expect(msg).not.toContain("%PDF")
  })

  test("opted-in small body is base64", () => {
    const bytes = new TextEncoder().encode("%PDF-1.4 tiny")
    const msg = formatBinaryOptedIn({ bytes, mime: "application/pdf" })
    expect(msg).toContain('encoding="base64"')
    expect(msg).toContain(Buffer.from(bytes).toString("base64"))
  })

  test("opted-in large body still withholds", () => {
    const bytes = new Uint8Array(MAX_INLINE_BINARY_BYTES + 10)
    bytes.set(new TextEncoder().encode("%PDF-1.4"), 0)
    const msg = formatBinaryOptedIn({ bytes, mime: "application/pdf", path: "/tmp/big.bin" })
    expect(msg).toContain("too large to inline")
    expect(msg).toContain("/tmp/big.bin")
  })
})

describe("persistBinaryBody", () => {
  test("writes under session blobs when session id set", () => {
    const home = mkdtempSync(join(tmpdir(), "ma-fetch-bin-"))
    tempDirs.push(home)
    const bytes = new TextEncoder().encode("%PDF-1.4")
    const r = persistBinaryBody({
      bytes,
      toolUseId: "toolu_test",
      sessionId: "sid-1",
      env: { MINIMAL_AGENT_HOME: home },
    })
    expect(r.path).toContain(`${home}/sessions/sid-1.blobs/toolu_test.bin`)
    expect(readFileSync(r.path)).toEqual(Buffer.from(bytes))
    expect(r.sha256.length).toBe(16)
  })
})
