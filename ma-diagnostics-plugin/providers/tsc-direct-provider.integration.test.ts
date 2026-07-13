import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { TscDirectProvider } from "./tsc-direct-provider.ts"

const REPO = join(import.meta.dir, "..", "..", "..")
const tscBin = join(REPO, "node_modules", ".bin", "tsc")
// Prefer an optional classic TS6 binary when present (e.g. a sibling project
// that still pins typescript@6). Override with MA_DIAG_TSC_BIN. Never hardcode
// a machine-local path.
const overrideBin = process.env.MA_DIAG_TSC_BIN
const bin = overrideBin && existsSync(overrideBin) ? overrideBin : tscBin

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "diag-tsc-direct-"))
}

describe("TscDirectProvider (real tsc)", () => {
  it.skipIf(!existsSync(bin))(
    "checks a single file with no tsconfig (defaults include jsx) and tags scope:ad-hoc",
    async () => {
      const dir = scratchDir()
      const file = join(dir, "standalone.ts")
      writeFileSync(file, `const x: number = "not a number"\n`)
      try {
        const p = new TscDirectProvider(bin, dir)
        const findings = await p.check(file, "")
        expect(findings.length).toBeGreaterThan(0)
        expect(findings.some((f) => f.code === "TS2322")).toBe(true)
        expect(findings.every((f) => f.scope === "ad-hoc")).toBe(true)
        expect(findings.every((f) => f.source === "tsc-direct")).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30000,
  )

  it.skipIf(!existsSync(bin))(
    "returns empty for a clean file",
    async () => {
      const dir = scratchDir()
      const file = join(dir, "clean.ts")
      writeFileSync(file, `const x: number = 42\n`)
      try {
        const p = new TscDirectProvider(bin, dir)
        expect(await p.check(file, "")).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30000,
  )

  it.skipIf(!existsSync(bin))(
    "extends project tsconfig so .tsx does not invent TS17004 (jsx) or path-alias noise",
    async () => {
      const dir = scratchDir()
      mkdirSync(join(dir, "src"), { recursive: true })
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            module: "ESNext",
            moduleResolution: "Bundler",
            target: "ES2022",
            strict: true,
            noEmit: true,
            paths: { "@/*": ["./src/*"] },
          },
          include: ["src"],
        }),
      )
      writeFileSync(join(dir, "src", "utils.ts"), `export const n = 1\n`)
      // Outside include on purpose — this is the ad-hoc case.
      const file = join(dir, "scratch.tsx")
      writeFileSync(file, `import { n } from '@/utils'\nexport const el = <div>{n}</div>\n`)
      try {
        const p = new TscDirectProvider(bin, dir)
        const findings = await p.check(file, "")
        // Must not invent "jsx not set" or "cannot find @/utils"
        expect(findings.every((f) => f.code !== "TS17004")).toBe(true)
        expect(findings.every((f) => f.code !== "TS6142")).toBe(true)
        expect(findings.every((f) => !(f.code === "TS2307" && f.message.includes("@/utils")))).toBe(
          true,
        )
        expect(findings.every((f) => f.scope === "ad-hoc")).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30000,
  )
})
