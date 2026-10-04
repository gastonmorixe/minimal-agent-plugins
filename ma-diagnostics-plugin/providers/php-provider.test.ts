/**
 * Tests for {@link PhpProvider} with an injected run function (no real spawns).
 * Covers finding mapping, exit-code fallback, and handles() gating.
 */
import { describe, expect, it } from "bun:test"

import { PhpProvider } from "./php-provider.ts"
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

describe("PhpProvider", () => {
  it("maps parse findings and spawns php -l on the relative path", async () => {
    const { runFn, calls } = fakeRun({
      code: 1,
      stdout: 'Parse error: syntax error, unexpected token ";" in src/a.php on line 4',
      stderr: "Errors parsing src/a.php",
    })
    const provider = new PhpProvider("php", ROOT, runFn)
    const findings = await provider.check("/repo/src/a.php", "")
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      source: "php",
      severity: "error",
      code: "syntax",
      path: "src/a.php",
      line: 4,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe("php")
    expect(calls[0].args).toEqual(["-l", "src/a.php"])
    expect(calls[0].opts.cwd).toBe(ROOT)
  })

  it("returns [] for clean exit", async () => {
    const { runFn } = fakeRun({
      code: 0,
      stdout: "No syntax errors detected in src/clean.php\n",
    })
    const provider = new PhpProvider("php", ROOT, runFn)
    expect(await provider.check("/repo/src/clean.php", "")).toEqual([])
  })

  it("emits a generic syntax finding when exit is non-zero and output does not parse", async () => {
    const { runFn } = fakeRun({
      code: 255,
      stdout: "",
      stderr: "segfault-ish failure",
    })
    const provider = new PhpProvider("php", ROOT, runFn)
    const findings = await provider.check("/repo/src/broken.php", "")
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      source: "php",
      severity: "error",
      code: "syntax",
      path: "src/broken.php",
    })
    expect(findings[0]?.message.toLowerCase()).not.toContain("run ")
  })

  it("falls back to the absolute path when the file is outside root", async () => {
    const { runFn, calls } = fakeRun({ code: 0, stdout: "" })
    const provider = new PhpProvider("php", ROOT, runFn)
    await provider.check("/other/project/src/outside.php", "")
    expect(calls[0].args[1]).toBe("/other/project/src/outside.php")
  })

  it("passes the abort signal through to the spawn", async () => {
    const { runFn, calls } = fakeRun({ code: 0, stdout: "" })
    const provider = new PhpProvider("php", ROOT, runFn)
    const signal = new AbortController().signal
    await provider.check("/repo/src/s.php", "", signal)
    expect(calls[0].opts.signal).toBe(signal)
  })

  describe("handles()", () => {
    const provider = new PhpProvider("php", ROOT)

    it.each(["a.php", "A.PHP", "src/deep/b.php"])("accepts %s", (name) => {
      expect(provider.handles(`/repo/${name}`)).toBe(true)
    })

    it.each(["a.ts", "a.py", "a.go", "a.md", "php"])("rejects %s", (name) => {
      expect(provider.handles(`/repo/src/${name}`)).toBe(false)
    })

    it("has stable identity fields", () => {
      expect(provider.id).toBe("php")
      expect(provider.kind).toBe("type")
    })
  })
})
