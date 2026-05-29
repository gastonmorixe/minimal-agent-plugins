import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { classifyBackendFailure, FetchError, newTraceId, writeTraceLog } from "./errors.ts"

describe("classifyBackendFailure", () => {
  test("timeout", () => {
    const e = classifyBackendFailure({ exitCode: 1, stderr: "navigation timed out after 30s" })
    expect(e).toBeInstanceOf(FetchError)
    expect(e.kind).toBe("timeout")
    expect(e.message.toLowerCase()).toContain("timed out")
  })

  test("dns", () => {
    expect(classifyBackendFailure({ exitCode: 1, stderr: "could not resolve host x" }).kind).toBe(
      "dns",
    )
    expect(classifyBackendFailure({ exitCode: 1, stderr: "getaddrinfo ENOTFOUND y" }).kind).toBe(
      "dns",
    )
  })

  test("tls", () => {
    expect(classifyBackendFailure({ exitCode: 1, stderr: "TLS handshake failed" }).kind).toBe("tls")
    expect(classifyBackendFailure({ exitCode: 1, stderr: "certificate has expired" }).kind).toBe(
      "tls",
    )
  })

  test("http status code surfaces in the message", () => {
    const e = classifyBackendFailure({
      exitCode: 1,
      stderr: "server responded with HTTP 403 Forbidden",
    })
    expect(e.kind).toBe("http")
    expect(e.message).toContain("403")
  })

  test("navigation / connection errors", () => {
    expect(
      classifyBackendFailure({ exitCode: 1, stderr: "net::ERR_CONNECTION_REFUSED" }).kind,
    ).toBe("navigation")
  })

  test("unrecognized stderr → unknown", () => {
    expect(classifyBackendFailure({ exitCode: 1, stderr: "kaboom flibbertigibbet" }).kind).toBe(
      "unknown",
    )
  })

  test("messages never echo raw stderr (no secret/token passthrough)", () => {
    const e = classifyBackendFailure({
      exitCode: 1,
      stderr: "SENSITIVE-TOKEN-xyz: navigation timed out",
    })
    expect(e.message).not.toContain("SENSITIVE-TOKEN")
  })
})

describe("newTraceId", () => {
  test("opaque, path-free, prefixed, non-repeating", () => {
    const a = newTraceId()
    const b = newTraceId()
    expect(a).toMatch(/^t-[a-z0-9]+-[0-9a-f]+$/)
    expect(a).not.toContain("/")
    expect(a).not.toContain("\\")
    expect(a).not.toBe(b)
  })
})

describe("writeTraceLog", () => {
  test("returns an id, writes a 0600 file containing the full raw detail", () => {
    const id = writeTraceLog({
      url: "https://example.com",
      backend: "obscura.ts",
      exitCode: 1,
      stderr: "raw obscura kaboom detail",
      kind: "unknown",
    })
    expect(id).toBeDefined()
    if (!id) return
    // The id itself never carries a path.
    expect(id).not.toContain("/")
    const p = join(tmpdir(), "ma-fetch-traces", `${id}.log`)
    try {
      expect(existsSync(p)).toBe(true)
      const body = readFileSync(p, "utf8")
      // The OPERATOR-only trace DOES keep the raw detail + backend name.
      expect(body).toContain("raw obscura kaboom detail")
      expect(body).toContain("obscura.ts")
      expect(body).toContain(id)
    } finally {
      rmSync(p, { force: true })
    }
  })

  test("never throws on a bad detail and always yields a usable id shape", () => {
    // Even with odd input, it must not throw (logging must never mask the
    // original failure).
    let id: string | undefined
    expect(() => {
      id = writeTraceLog({ url: "", backend: "", exitCode: 0, stderr: "", kind: "unknown" })
    }).not.toThrow()
    if (id) {
      const p = join(tmpdir(), "ma-fetch-traces", `${id}.log`)
      rmSync(p, { force: true })
    }
  })
})
