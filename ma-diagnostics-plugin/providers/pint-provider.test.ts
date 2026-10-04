/**
 * Tests for {@link PintProvider} with an injected run function (no real spawns).
 * Covers handles() gating, spawn args, and finding mapping from fake JSON.
 */
import { describe, expect, it } from "bun:test"

import { PINT_GENERIC_MESSAGE } from "../adapters/pint.ts"

import { PintProvider } from "./pint-provider.ts"
import type { SpawnResult } from "./spawn.ts"

const ROOT = "/repo"

function fakeRun(result: Partial<SpawnResult>) {
  const calls: { bin: string; args: string[]; opts: { cwd: string; signal?: AbortSignal } }[] = []
  const runFn = (
    bin: string,
    args: string[],
    opts: { cwd: string; signal?: AbortSignal },
  ): Promise<SpawnResult> => {
    calls.push({ bin, args, opts })
    return Promise.resolve({ stdout: "", stderr: "", code: 0, ...result })
  }
  return { runFn: runFn as typeof import("./spawn.ts").runCapture, calls }
}

describe("PintProvider", () => {
  it("maps JSON findings and passes check-only flags before --", async () => {
    const { runFn, calls } = fakeRun({
      code: 1,
      stdout: JSON.stringify({
        files: [
          {
            name: "app/Models/User.php",
            appliedFixers: ["ordered_imports"],
          },
        ],
      }),
    })
    const provider = new PintProvider("/repo/vendor/bin/pint", ROOT, runFn)
    const findings = await provider.check("/repo/app/Models/User.php", "")
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      source: "pint",
      severity: "warning",
      code: "format",
      path: "app/Models/User.php",
      message:
        "File does not match the project's formatting rules (reported by pint): ordered_imports.",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe("/repo/vendor/bin/pint")
    expect(calls[0].args).toEqual(["--test", "--format=json", "-v", "--", "app/Models/User.php"])
    expect(calls[0].opts.cwd).toBe(ROOT)
  })

  it("returns [] for clean exit with empty files", async () => {
    const { runFn } = fakeRun({
      code: 0,
      stdout: JSON.stringify({ files: [] }),
    })
    const provider = new PintProvider("pint", ROOT, runFn)
    expect(await provider.check("/repo/src/clean.php", "")).toEqual([])
  })

  it("emits a generic format finding when exit is 1 and JSON/text are empty", async () => {
    const { runFn } = fakeRun({
      code: 1,
      stdout: JSON.stringify({ files: [] }),
      stderr: "",
    })
    const provider = new PintProvider("pint", ROOT, runFn)
    const findings = await provider.check("/repo/src/dirty.php", "")
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      source: "pint",
      severity: "warning",
      code: "format",
      path: "src/dirty.php",
      message: PINT_GENERIC_MESSAGE,
    })
  })

  it("falls back to the absolute path when the file is outside root", async () => {
    const { runFn, calls } = fakeRun({ code: 0, stdout: "" })
    const provider = new PintProvider("pint", ROOT, runFn)
    await provider.check("/other/project/src/outside.php", "")
    expect(calls[0].args.at(-1)).toBe("/other/project/src/outside.php")
    expect(calls[0].args).toContain("--")
  })

  describe("handles()", () => {
    const provider = new PintProvider("pint", ROOT)

    it("accepts .php paths", () => {
      expect(provider.handles("/repo/app/a.php")).toBe(true)
      expect(provider.handles("/repo/A.PHP")).toBe(true)
    })

    it("rejects non-php paths", () => {
      expect(provider.handles("/repo/a.ts")).toBe(false)
      expect(provider.handles("/repo/a.py")).toBe(false)
      expect(provider.handles("/repo/README.md")).toBe(false)
    })

    it("has stable identity fields and dispose is a no-op", () => {
      expect(provider.id).toBe("pint")
      expect(provider.kind).toBe("format")
      expect(() => provider.dispose()).not.toThrow()
    })
  })
})
