/**
 * Tests of the helper path and the spawn lock path. The first group reads no
 * file. The second group makes files in a temp folder from `os.tmpdir()`,
 * made in `beforeAll` and removed in `afterAll`.
 *
 * @module lib/paths.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { helperApp, helperBinary, socketPath, spawnLockPath } from "./paths.ts"

const PKG = "/pkg/ma-computer-use-plugin"
const SINGLE = join(PKG, "native", "build", "ComputerUseHelper")

describe("helperBinary", () => {
  test("CUD_HELPER wins over the built file", () => {
    expect(helperBinary(PKG, { CUD_HELPER: "/x/helper" })).toBe("/x/helper")
  })

  test("an empty CUD_HELPER is ignored", () => {
    expect(helperBinary(PKG, { CUD_HELPER: "" })).toBe(SINGLE)
  })

  test("with nothing built, it gives the single-binary path", () => {
    expect(helperBinary(PKG, {})).toBe(SINGLE)
  })

  test("helperApp is the legacy bundle dir", () => {
    expect(helperApp(PKG)).toBe(join(PKG, "native", "build", "ComputerUseHelper.app"))
  })
})

describe("helperBinary with files on disk (H3: no legacy .app fallback)", () => {
  let root = ""
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cu-paths-test-"))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("only the legacy .app is built: it gives the single-binary path, not the .app", () => {
    const pkg = join(root, "legacy-only")
    const legacyDir = join(pkg, "native", "build", "ComputerUseHelper.app", "Contents", "MacOS")
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, "ComputerUseHelper"), "")
    expect(helperBinary(pkg, {})).toBe(join(pkg, "native", "build", "ComputerUseHelper"))
  })

  test("a file at the single-binary path is the helper", () => {
    const pkg = join(root, "file-case")
    mkdirSync(join(pkg, "native", "build"), { recursive: true })
    writeFileSync(join(pkg, "native", "build", "ComputerUseHelper"), "")
    expect(helperBinary(pkg, {})).toBe(join(pkg, "native", "build", "ComputerUseHelper"))
  })
})

describe("spawnLockPath", () => {
  test("is next to the socket, in the support dir by default", () => {
    const env = { CUD_DIR: "/support" }
    expect(socketPath(env)).toBe("/support/cud.sock")
    expect(spawnLockPath(env)).toBe("/support/cud.sock.spawn.lock")
  })

  test("follows CUD_SOCK", () => {
    expect(spawnLockPath({ CUD_SOCK: "/t/test.sock" })).toBe("/t/test.sock.spawn.lock")
  })
})
