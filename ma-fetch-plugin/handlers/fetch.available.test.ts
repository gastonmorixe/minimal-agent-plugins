import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { available, resetFetchAvailabilityForTest } from "./fetch.ts"

describe("Fetch availability (tool advertisement)", () => {
  let dir: string
  let prevCfg: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-fetch-avail-"))
    prevCfg = process.env.MINIMAL_AGENT_CONFIG
    // Empty config: no operator override, so only the managed dir counts.
    writeFileSync(join(dir, "config.jsonc"), "{}")
    process.env.MINIMAL_AGENT_CONFIG = join(dir, "config.jsonc")
    resetFetchAvailabilityForTest()
  })
  afterEach(() => {
    if (prevCfg === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevCfg
    resetFetchAvailabilityForTest()
    rmSync(dir, { recursive: true, force: true })
  })

  test("hidden when the managed engine is not installed", () => {
    expect(available({ env: { MINIMAL_AGENT_BIN_DIR: dir } })).toBe(false)
    expect(available({ env: {} })).toBe(false)
  })

  test("shown once the engine exists, and stays shown", () => {
    expect(available({ env: { MINIMAL_AGENT_BIN_DIR: dir } })).toBe(false)
    writeFileSync(join(dir, "obscura"), "")
    expect(available({ env: { MINIMAL_AGENT_BIN_DIR: dir } })).toBe(true)
    rmSync(join(dir, "obscura"))
    expect(available({ env: { MINIMAL_AGENT_BIN_DIR: dir } })).toBe(true)
  })

  test("shown when the operator override is set", () => {
    writeFileSync(
      join(dir, "config.jsonc"),
      JSON.stringify({ plugins: { "ma-fetch": { obscura: { bin: "/opt/obscura" } } } }),
    )
    expect(available({ env: {} })).toBe(true)
  })
})
