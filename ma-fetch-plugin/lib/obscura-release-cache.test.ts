import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import {
  isCachedObscuraReleaseFresh,
  obscuraReleaseCachePath,
  readCachedObscuraRelease,
  writeCachedObscuraRelease,
} from "./obscura-release-cache.ts"

const BUILD = {
  version: "424242",
  tag: "latest",
  asset: "obscura-aarch64-macos-424242.tar.gz",
  sha256: "c".repeat(64),
  platform: "darwin-arm64",
}

let tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ma-fetch-release-cache-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

describe("obscura release cache", () => {
  test("writes and reads a valid platform-specific record", () => {
    const home = tempDir()
    const path = obscuraReleaseCachePath(home, BUILD.platform)
    writeCachedObscuraRelease(path, BUILD, 1_000)

    expect(readCachedObscuraRelease(path)).toEqual({ ...BUILD, checkedAt: 1_000 })
    expect(readFileSync(path, "utf8")).not.toContain("token")
  })

  test("uses the TTL boundary without treating an exact expiry as fresh", () => {
    const cached = { ...BUILD, checkedAt: 1_000 }
    expect(isCachedObscuraReleaseFresh(cached, 1_001, 2)).toBe(true)
    expect(isCachedObscuraReleaseFresh(cached, 1_002, 2)).toBe(false)
  })

  test("rejects corrupt or untrusted cache data", () => {
    const home = tempDir()
    const path = obscuraReleaseCachePath(home, BUILD.platform)

    mkdirSync(join(home, "cache", "ma-fetch"), { recursive: true })
    writeFileSync(path, "not json")
    expect(readCachedObscuraRelease(path)).toBeNull()

    writeFileSync(path, JSON.stringify({ schemaVersion: 1, checkedAt: 1, ...BUILD, sha256: "bad" }))
    expect(readCachedObscuraRelease(path)).toBeNull()

    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, checkedAt: 1, ...BUILD, platform: "other" }),
    )
    expect(readCachedObscuraRelease(path)).toBeNull()
  })
})
