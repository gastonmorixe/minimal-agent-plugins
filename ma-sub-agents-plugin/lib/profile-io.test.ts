/** Tests for the startup-profile writer (REVIEW #11). */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { StartupProfile } from "./host-types.ts"
import { profilePathFor, writeStartupProfile } from "./profile-io.ts"

const PROFILE: StartupProfile = {
  version: 1,
  systemPrompt: {},
  noAgentsMd: false,
  pluginPrompts: { all: false, suppress: [], keep: [] },
  plugins: { disable: [], enable: [] },
  bare: false,
  tools: { kind: "all" },
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "subagents-profile-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("writeStartupProfile", () => {
  it("writes mode 0600 even when a stale tmp file exists", () => {
    const path = profilePathFor(dir, "abc")
    expect(path).toBe(join(dir, "abc.profile.json"))
    writeFileSync(`${path}.${process.pid}.tmp`, "stale", { mode: 0o644 })
    writeStartupProfile(path, PROFILE)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(["abc.profile.json"])
  })

  it("removes the tmp file and throws when the rename fails", () => {
    // The target is a non-empty directory, so rename cannot replace it.
    const path = join(dir, "target")
    mkdirSync(path)
    writeFileSync(join(path, "keep"), "x")
    expect(() => writeStartupProfile(path, PROFILE)).toThrow()
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false)
  })
})
