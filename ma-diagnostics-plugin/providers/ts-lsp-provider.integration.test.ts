/**
 * Integration test for {@link TsLspProvider} against the REAL TypeScript LSP in
 * this repo. Proves the persistent-server path end to end: boot once, then
 * warm per-edit type diagnostics with correct TS codes.
 *
 * As of TypeScript 7 GA the native LSP lives in the `tsc` binary
 * (`tsc --lsp -stdio`); the legacy `@typescript/native-preview` `tsgo` binary
 * spoke the same protocol. This test prefers `tsc` and falls back to `tsgo`,
 * and is skipped when neither LSP-capable binary is present so the suite stays
 * green elsewhere.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { TsLspProvider } from "./ts-lsp-provider.ts"

// Repo root is two levels up from this providers/ dir (ma-diagnostics-plugin is
// a workspace member of the plugins repo, whose root holds the hoisted
// node_modules/.bin).
const REPO = join(import.meta.dir, "..", "..")

/** Prefer the TS7 `tsc` LSP; fall back to the legacy `tsgo` preview binary. */
function resolveLspBin(): { bin: string; id: string } | null {
  const tsc = join(REPO, "node_modules", ".bin", "tsc")
  if (existsSync(tsc)) return { bin: tsc, id: "tsc" }
  const tsgo = join(REPO, "node_modules", ".bin", "tsgo")
  if (existsSync(tsgo)) return { bin: tsgo, id: "tsgo" }
  return null
}

const lsp = resolveLspBin()
// A real, in-tsconfig-scope TypeScript file in this repo to type-check.
const target = join(REPO, "ma-diagnostics-plugin", "lib", "detect.ts")

describe("TsLspProvider (real TypeScript LSP)", () => {
  it.skipIf(!lsp || !existsSync(target))(
    "detects an injected type error with a real TS code",
    async () => {
      const { readFileSync } = await import("node:fs")
      // biome-ignore lint/style/noNonNullAssertion: guarded by skipIf above.
      const { bin, id } = lsp!
      const provider = new TsLspProvider(bin, REPO, id)
      try {
        const clean = readFileSync(target, "utf8")
        const broken = `${clean}\nconst __probe: number = "not a number"\n`

        // clean buffer → no NEW errors from our probe line
        const cleanFindings = await provider.check(target, clean)
        expect(Array.isArray(cleanFindings)).toBe(true)

        // broken buffer → a TS2322 assignability error
        const brokenFindings = await provider.check(target, broken)
        expect(brokenFindings.some((f) => f.code === "TS2322")).toBe(true)
        expect(brokenFindings.every((f) => f.source === id)).toBe(true)

        // STALE-DIAGNOSTICS SMOKE TEST (Nancy / claude-code#64239): after
        // fixing the error, the server must NOT keep reporting it. A stale
        // TS2322 here would mean the LSP didn't process our didChange.
        const refixed = await provider.check(target, clean)
        expect(refixed.some((f) => f.code === "TS2322")).toBe(false)

        // warm loop is fast: a few more cycles resolve quickly
        const t0 = performance.now()
        await provider.check(target, clean)
        const warmMs = performance.now() - t0
        // generous ceiling (CI noise); the point is "not a fresh 300ms spawn"
        expect(warmMs).toBeLessThan(150)
      } finally {
        provider.dispose()
      }
    },
    20_000,
  )
})
