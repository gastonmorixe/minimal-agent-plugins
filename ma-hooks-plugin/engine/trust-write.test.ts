/**
 * State write errors (B2 review minor): a failed write leaves no temp file.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { makeSandbox, type Sandbox } from "./test-support.ts"
import { TrustStore } from "./trust.ts"

let sb: Sandbox

beforeEach(() => {
  sb = makeSandbox()
})

afterEach(() => {
  sb.cleanup()
})

describe("TrustStore write", () => {
  test("rename fails: the error is thrown and no temp file stays", () => {
    const dir = join(sb.root, "state")
    const path = join(dir, "hooks-state.json")
    // A non-empty directory at the target path makes the rename fail.
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, "keep"), "x")
    const store = new TrustStore(path, false)
    expect(() => store.setEnabled(sb.project, "k1", false)).toThrow()
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([])
  })

  test("normal write: state saved, no temp file stays", () => {
    const dir = join(sb.root, "state")
    const path = join(dir, "hooks-state.json")
    const store = new TrustStore(path, false)
    store.setEnabled(sb.project, "k1", false)
    expect(readdirSync(dir)).toEqual(["hooks-state.json"])
  })
})
