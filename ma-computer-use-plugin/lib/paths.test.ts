/**
 * Tests of the helper path order. The `exists` check is injected, so no file
 * on disk is read.
 *
 * @module lib/paths.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { helperApp, helperBinary } from "./paths.ts"

const PKG = "/pkg/ma-computer-use-plugin"
const SINGLE = join(PKG, "native", "build", "ComputerUseHelper")
const LEGACY = join(
  PKG,
  "native",
  "build",
  "ComputerUseHelper.app",
  "Contents",
  "MacOS",
  "ComputerUseHelper",
)

/** An `exists` check that is true only for the given paths. */
function only(...paths: string[]): (path: string) => boolean {
  const set = new Set(paths)
  return (path) => set.has(path)
}

describe("helperBinary order", () => {
  test("CUD_HELPER wins over the built files", () => {
    expect(helperBinary(PKG, { CUD_HELPER: "/x/helper" }, only(SINGLE, LEGACY))).toBe("/x/helper")
  })

  test("an empty CUD_HELPER is ignored", () => {
    expect(helperBinary(PKG, { CUD_HELPER: "" }, only(SINGLE))).toBe(SINGLE)
  })

  test("the single binary wins over the legacy .app", () => {
    expect(helperBinary(PKG, {}, only(SINGLE, LEGACY))).toBe(SINGLE)
  })

  test("the legacy .app executable is used when only it exists", () => {
    expect(helperBinary(PKG, {}, only(LEGACY))).toBe(LEGACY)
  })

  test("with nothing built, it gives the single-binary path", () => {
    expect(helperBinary(PKG, {}, only())).toBe(SINGLE)
  })

  test("helperApp is the legacy bundle dir", () => {
    expect(helperApp(PKG)).toBe(join(PKG, "native", "build", "ComputerUseHelper.app"))
  })
})

describe("helperBinary default exists check", () => {
  // native/build is gitignored, so a failed run leaves no tracked file.
  const buildDir = join(import.meta.dir, "..", "native", "build")
  mkdirSync(buildDir, { recursive: true })
  const root = mkdtempSync(join(buildDir, ".paths-test-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("a directory at the single-binary path does not count", () => {
    const pkg = join(root, "dir-case")
    mkdirSync(join(pkg, "native", "build", "ComputerUseHelper"), { recursive: true })
    const legacyDir = join(pkg, "native", "build", "ComputerUseHelper.app", "Contents", "MacOS")
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, "ComputerUseHelper"), "")
    expect(helperBinary(pkg, {})).toBe(join(legacyDir, "ComputerUseHelper"))
  })

  test("a file at the single-binary path counts", () => {
    const pkg = join(root, "file-case")
    mkdirSync(join(pkg, "native", "build"), { recursive: true })
    writeFileSync(join(pkg, "native", "build", "ComputerUseHelper"), "")
    expect(helperBinary(pkg, {})).toBe(join(pkg, "native", "build", "ComputerUseHelper"))
  })
})
