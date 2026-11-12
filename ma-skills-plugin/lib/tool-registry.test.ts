import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { skillScriptEnv, toolSpecToHandler } from "./tool-registry.ts"
import type { ToolSpec } from "./types.ts"

describe("skillScriptEnv", () => {
  test("drops BUN_BE_BUN and undefined values, keeps the rest", () => {
    expect(skillScriptEnv({ PATH: "/bin", BUN_BE_BUN: "1", GONE: undefined })).toEqual({
      PATH: "/bin",
    })
  })
})

describe("script tool handler env", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-env-"))
    mkdirSync(join(dir, "scripts"))
    const script = join(dir, "scripts", "show-env")
    writeFileSync(script, '#!/bin/sh\necho "be=${BUN_BE_BUN-unset} keep=${SKILL_KEEP-unset}"\n')
    chmodSync(script, 0o755)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("the script runs by shebang and never sees BUN_BE_BUN", async () => {
    const spec = {
      name: "ShowEnv",
      description: "print env",
      parameters: { type: "object", properties: {} },
      handler: { type: "script", path: "scripts/show-env", argTemplate: "x" },
    } as unknown as ToolSpec
    const h = toolSpecToHandler(spec, dir, {
      env: { PATH: process.env.PATH, BUN_BE_BUN: "1", SKILL_KEEP: "yes" },
    }) as { invoke: (ctx: Record<string, unknown>) => Promise<Record<string, unknown>> }
    const r = await h.invoke({ trigger: { type: "tool", input: {} } })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toBe("be=unset keep=yes")
  })
})
