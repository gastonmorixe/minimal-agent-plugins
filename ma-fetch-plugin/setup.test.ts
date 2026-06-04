import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import setup from "./setup.ts"

interface FakeInv {
  dir: string
  has(name: string): boolean
  get(name: string): { version: string | null } | undefined
  status(): "satisfied" | "missing" | "outdated" | "unknown-version"
}

function ctx(inv: Partial<FakeInv> = {}, env: Record<string, string> = {}) {
  return {
    packageDir: "/pkg",
    cwd: "/cwd",
    env,
    binaries: {
      dir: "/bin",
      has: () => false,
      get: () => undefined,
      status: () => "missing" as const,
      ...inv,
    },
    log: { info: () => {}, notice: () => {} },
  }
}

describe("ma-fetch setup()", () => {
  let cfgDir: string
  let prevCfg: string | undefined

  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), "ma-fetch-setup-"))
    prevCfg = process.env.MINIMAL_AGENT_CONFIG
  })
  afterEach(() => {
    if (prevCfg === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevCfg
    rmSync(cfgDir, { recursive: true, force: true })
  })

  test("skips provisioning when obscura.bin is configured", () => {
    const cfgPath = join(cfgDir, "config.jsonc")
    writeFileSync(
      cfgPath,
      `{
        // operator points at a local build
        "plugins": { "ma-fetch": { "obscura": { "bin": "/Users/me/Projects/obscura/target/release/obscura" } } },
      }`,
    )
    process.env.MINIMAL_AGENT_CONFIG = cfgPath
    const result = setup(ctx())
    expect(result.requireBinaries).toBeUndefined()
    expect(result.haltIfMissing).toBeUndefined()
  })

  test("declares obscura with worker sibling on a supported platform", () => {
    const cfgPath = join(cfgDir, "config.jsonc")
    writeFileSync(cfgPath, `{}`)
    process.env.MINIMAL_AGENT_CONFIG = cfgPath
    const result = setup(ctx())

    // Structure is asserted only on platforms that have a real sha pinned (a
    // build whose sha256 is still empty is treated as "not published yet").
    const spec = result.requireBinaries?.[0]
    if (spec) {
      expect(spec.name).toBe("obscura")
      expect(spec.archiveMember).toBe("obscura")
      expect(spec.archiveExtraMembers).toEqual(["obscura-worker"])
      expect(spec.source.kind).toBe("github-release")
      if (spec.source.kind === "github-release") {
        expect(spec.source.repo).toBe("gastonmorixe/obscura-dist")
        expect(spec.source.asset).toContain("obscura-")
      }
      expect(result.haltIfMissing).toEqual(["obscura"])
      expect(result.haltMessage).toContain("obscura")
    } else {
      // No real build pinned for this platform yet → no requirement emitted.
      expect(result.requireBinaries).toBeUndefined()
    }
  })
})
