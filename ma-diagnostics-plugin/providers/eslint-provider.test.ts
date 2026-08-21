/**
 * Tests for {@link EslintProvider} with an injected run function (no real
 * spawns). Covers finding mapping, exit-code handling, and handles() gating.
 */
import { describe, expect, it } from "bun:test"

import { EslintProvider } from "./eslint-provider.ts"
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

function eslintJson(messages: unknown[], filePath = "/repo/src/a.ts"): string {
  return JSON.stringify([{ filePath, messages }])
}

describe("EslintProvider", () => {
  it("maps findings on a lint-problems exit (code 1)", async () => {
    const { runFn, calls } = fakeRun({
      code: 1,
      stdout: eslintJson([
        {
          ruleId: "no-unused-vars",
          severity: 2,
          line: 4,
          column: 7,
          message: "'x' is assigned a value but never used.",
        },
      ]),
    })
    const provider = new EslintProvider("eslint", ROOT, runFn)
    const findings = await provider.check("/repo/src/a.ts", "")
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      source: "eslint",
      severity: "error",
      line: 4,
      col: 7,
      code: "no-unused-vars",
      path: "/repo/src/a.ts",
    })
    // Spawn shape: relative path + json reporter, cwd = root.
    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe("eslint")
    expect(calls[0].args).toEqual(["src/a.ts", "--format", "json"])
    expect(calls[0].opts.cwd).toBe(ROOT)
  })

  it("returns [] for clean exit (code 0)", async () => {
    const { runFn } = fakeRun({ code: 0, stdout: eslintJson([]) })
    const provider = new EslintProvider("eslint", ROOT, runFn)
    expect(await provider.check("/repo/src/clean.ts", "")).toEqual([])
  })

  it("returns [] for empty stdout with exit 1 (no findings recorded)", async () => {
    const { runFn } = fakeRun({ code: 1, stdout: "" })
    const provider = new EslintProvider("eslint", ROOT, runFn)
    expect(await provider.check("/repo/src/empty.ts", "")).toEqual([])
  })

  it("throws on exit 2 so the runner degrades the provider", async () => {
    const { runFn } = fakeRun({
      code: 2,
      stdout: "",
      stderr: "Oops! Something went wrong :(\nESLint: 10.0.0",
    })
    const provider = new EslintProvider("eslint", ROOT, runFn)
    await expect(provider.check("/repo/src/broken.ts", "")).rejects.toThrow(/exit 2/)
  })

  it("falls back to the absolute path when the file is outside root", async () => {
    const { runFn, calls } = fakeRun({ code: 0, stdout: "" })
    const provider = new EslintProvider("eslint", ROOT, runFn)
    await provider.check("/other/project/src/outside.ts", "")
    expect(calls[0].args[0]).toBe("/other/project/src/outside.ts")
  })

  it("passes the abort signal through to the spawn", async () => {
    const { runFn, calls } = fakeRun({ code: 0, stdout: "" })
    const provider = new EslintProvider("eslint", ROOT, runFn)
    const signal = new AbortController().signal
    await provider.check("/repo/src/s.ts", "", signal)
    expect(calls[0].opts.signal).toBe(signal)
  })

  describe("handles()", () => {
    const provider = new EslintProvider("eslint", ROOT)

    it.each([
      "a.ts",
      "a.tsx",
      "a.mts",
      "a.cts",
      "a.js",
      "a.jsx",
      "a.mjs",
      "a.cjs",
    ])("accepts %s", (name) => {
      expect(provider.handles(`/repo/src/${name}`)).toBe(true)
    })

    it.each(["a.py", "a.go", "a.css", "a.json", "a.md", "ts"])("rejects %s", (name) => {
      expect(provider.handles(`/repo/src/${name}`)).toBe(false)
    })

    it("has stable identity fields", () => {
      expect(provider.id).toBe("eslint")
      expect(provider.kind).toBe("lint")
    })
  })
})
