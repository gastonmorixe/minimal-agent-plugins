/**
 * Unit tests for {@link PrettierProvider}: extension gating, interface
 * contract, and the format-diff enrichment path, all with an injected fake
 * runner (no real prettier spawn). Real spawn behavior is covered by the
 * integration suite.
 */
import { describe, expect, it } from "bun:test"

import { PrettierProvider } from "./prettier-provider.ts"
import type { SpawnResult } from "./spawn.ts"

const GENERIC = "File does not match the project's formatting rules (reported by prettier)."

function res(over: Partial<SpawnResult>): SpawnResult {
  return { stdout: "", stderr: "", code: 0, ...over }
}

/** Fake runner scripted per call order: check first, then stdin format. */
function fakeRunner(
  calls: Array<{ bin: string; args: string[]; input?: string }>,
  script: (call: number, bin: string, args: string[], opts?: { input?: string }) => SpawnResult,
) {
  return (
    bin: string,
    args: string[],
    opts?: { cwd: string; input?: string; signal?: AbortSignal },
  ): Promise<SpawnResult> => {
    calls.push({ bin, args, input: opts?.input })
    return Promise.resolve(script(calls.length - 1, bin, args, opts))
  }
}

describe("PrettierProvider", () => {
  describe("handles", () => {
    const provider = new PrettierProvider("/usr/bin/prettier", "/tmp/testroot")
    it("handles formattable extensions like biome", () => {
      expect(provider.handles("src/file.ts")).toBe(true)
      expect(provider.handles("Comp.tsx")).toBe(true)
      expect(provider.handles("cfg.json")).toBe(true)
      expect(provider.handles("cfg.jsonc")).toBe(true)
      expect(provider.handles("styles.css")).toBe(true)
      expect(provider.handles("mod.mjs")).toBe(true)
      expect(provider.handles("file.js")).toBe(true)
    })

    it("rejects non-formattable files", () => {
      expect(provider.handles("README.md")).toBe(false)
      expect(provider.handles("file.py")).toBe(false)
      expect(provider.handles("Makefile")).toBe(false)
    })
  })

  describe("interface contract", () => {
    const provider = new PrettierProvider("/usr/bin/prettier", "/tmp/testroot")
    it("has correct id and kind", () => {
      expect(provider.id).toBe("prettier")
      expect(provider.kind).toBe("format")
    })

    it("dispose is a no-op that does not throw", () => {
      expect(() => provider.dispose()).not.toThrow()
    })
  })

  describe("check", () => {
    it("runs --check on the rel path and returns generic findings when clean-exit but warns", async () => {
      const calls: Array<{ bin: string; args: string[]; input?: string }> = []
      const provider = new PrettierProvider(
        "/bin/prettier",
        "/root",
        fakeRunner(calls, (_i, _bin, args) => {
          if (args[0] === "--check") {
            return res({ stdout: "[warn] src/a.ts\n", code: 1 })
          }
          throw new Error("unexpected second call")
        }),
      )
      // Empty text: no enrichment attempted.
      const findings = await provider.check("/root/src/a.ts", "")
      expect(findings).toHaveLength(1)
      expect(findings[0]).toMatchObject({
        source: "prettier",
        severity: "warning",
        code: "format",
        path: "src/a.ts",
        message: GENERIC,
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.args).toContain("--check")
      expect(calls[0]?.args).toContain("src/a.ts")
    })

    it("parses [warn] lines from STDERR (prettier 3.x layout)", async () => {
      const provider = new PrettierProvider(
        "/bin/prettier",
        "/root",
        fakeRunner([], (_i, _bin, args) => {
          if (args[0] === "--check") {
            return res({
              stdout: "Checking formatting...\n",
              stderr: "[warn] src/stderr-file.ts\n",
              code: 1,
            })
          }
          throw new Error("unexpected second call")
        }),
      )
      const findings = await provider.check("/root/src/stderr-file.ts", "")
      expect(findings).toHaveLength(1)
      expect(findings[0]?.path).toBe("src/stderr-file.ts")
    })

    it("enriches the finding with the expected-content diff on stdin success", async () => {
      const calls: Array<{ bin: string; args: string[]; input?: string }> = []
      const formatted = "const a = 1;\nconst b = 2;\n"
      const provider = new PrettierProvider(
        "/bin/prettier",
        "/root",
        fakeRunner(calls, (_i, _bin, args, _opts) => {
          if (args[0] === "--check") return res({ stdout: "[warn] src/b.ts\n", code: 1 })
          expect(args[0]).toBe("--stdin-filepath=src/b.ts")
          return res({ stdout: formatted, code: 0 })
        }),
      )
      const text = "const a=1;\nconst b=2;\n"
      const findings = await provider.check("/root/src/b.ts", text)
      expect(calls).toHaveLength(2)
      expect(calls[1]?.input).toBe(text)
      expect(findings[0]?.message).toContain(GENERIC.replace(/\.$/, "."))
      expect(findings[0]?.message).toContain("Expected content at line 1")
      expect(findings[0]?.message).toContain("-const a=1;")
      expect(findings[0]?.message).toContain("+const a = 1;")
      expect(findings[0]?.message).toContain(
        "Format the file according to the project's formatting setup.",
      )
      expect(findings[0]?.message).not.toContain("run ")
    })

    it("truncates long diffs at MAX_DIFF_LINES with a marker", async () => {
      // Build a file whose diff body exceeds 20 lines.
      const before = Array.from({ length: 30 }, (_, i) => `const v${i}=1;`).join("\n") + "\n"
      const after = Array.from({ length: 30 }, (_, i) => `const v${i} = 1;`).join("\n") + "\n"
      let stdinCalled = false
      const provider = new PrettierProvider(
        "/bin/prettier",
        "/root",
        fakeRunner([], (_i, _bin, args) => {
          if (args[0] === "--check") return res({ stdout: "[warn] src/big.ts\n", code: 1 })
          stdinCalled = true
          return res({ stdout: after, code: 0 })
        }),
      )
      const findings = await provider.check("/root/src/big.ts", before)
      expect(stdinCalled).toBe(true)
      const msg = findings[0]?.message ?? ""
      expect(msg).toContain("(truncated)")
      // Max 20 diff-body lines: count only -, +, and context lines (the header,
      // the …(truncated) marker, and the guidance trailer don't start with one).
      const diffBody = msg.split("\n").filter((l) => /^[-+ ]/.test(l))
      expect(diffBody.length).toBe(20)
    })

    it("keeps the generic message when the stdin run exits non-zero", async () => {
      const provider = new PrettierProvider(
        "/bin/prettier",
        "/root",
        fakeRunner([], (_i, _bin, args) => {
          if (args[0] === "--check") return res({ stdout: "[warn] src/c.ts\n", code: 1 })
          return res({ stdout: "", stderr: "boom", code: 2 })
        }),
      )
      const findings = await provider.check("/root/src/c.ts", "const a=1;\n")
      expect(findings).toHaveLength(1)
      expect(findings[0]?.message).toBe(GENERIC)
    })

    it("keeps the generic message when the runner throws on the stdin pass", async () => {
      const provider = new PrettierProvider(
        "/bin/prettier",
        "/root",
        fakeRunner([], (_i, _bin, args) => {
          if (args[0] === "--check") return res({ stdout: "[warn] src/d.ts\n", code: 1 })
          throw new Error("spawn failure")
        }),
      )
      const findings = await provider.check("/root/src/d.ts", "const a=1;\n")
      expect(findings[0]?.message).toBe(GENERIC)
    })

    it("returns [] when check output has no warn lines (clean file)", async () => {
      const provider = new PrettierProvider(
        "/bin/prettier",
        "/root",
        fakeRunner([], () =>
          res({ stdout: "All matched files use Prettier code style!\n", code: 0 }),
        ),
      )
      const findings = await provider.check("/root/src/e.ts", "const a = 1;\n")
      expect(findings).toEqual([])
    })

    it("falls back to the absolute path when outside root", async () => {
      const calls: Array<{ bin: string; args: string[] }> = []
      const provider = new PrettierProvider(
        "/bin/prettier",
        "/root",
        fakeRunner(calls, (_i, _bin, args) => {
          if (args[0] === "--check") return res({ stdout: "", code: 0 })
          throw new Error("unexpected stdin call")
        }),
      )
      await provider.check("/elsewhere/src/f.ts", "const a = 1;\n")
      expect(calls[0]?.args).toContain("/elsewhere/src/f.ts")
    })
  })
})
