/**
 * Unit tests for {@link isPathInTsconfigScope}.
 *
 * These exercise the lightweight include/exclude path (plugin workspace is on
 * TypeScript 7 without the classic programmatic API). Classic-API coverage is
 * exercised indirectly when the target project pins TS ≤ 6.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { isPathInTsconfigScope, resetTsconfigScopeCache } from "./tsconfig-scope.ts"

function fixture(opts: {
  include?: string[]
  exclude?: string[]
  paths?: Record<string, string[]>
  files: Record<string, string>
}): string {
  const root = mkdtempSync(join(tmpdir(), "diag-ts-scope-"))
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "scope-fixture", private: true, type: "module" }),
  )

  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        strict: true,
        paths: opts.paths ?? { "@/*": ["./src/*"] },
      },
      include: opts.include ?? ["src"],
      ...(opts.exclude ? { exclude: opts.exclude } : {}),
    }),
  )

  for (const [rel, body] of Object.entries(opts.files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, body)
  }
  return root
}

describe("isPathInTsconfigScope", () => {
  it("returns true for a file under include", () => {
    resetTsconfigScopeCache()
    const root = fixture({
      files: {
        "src/lib/utils.ts": "export const x = 1\n",
        "src/routes/app.tsx": "import { x } from '@/lib/utils'\nexport const y = x\n",
      },
    })
    try {
      expect(isPathInTsconfigScope(root, join(root, "src/routes/app.tsx"))).toBe(true)
      expect(isPathInTsconfigScope(root, join(root, "src/lib/utils.ts"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      resetTsconfigScopeCache()
    }
  })

  it("returns false for a file outside include", () => {
    resetTsconfigScopeCache()
    const root = fixture({
      include: ["src"],
      files: {
        "src/in.ts": "export {}\n",
        "scratch/out.ts": "export {}\n",
      },
    })
    try {
      expect(isPathInTsconfigScope(root, join(root, "src/in.ts"))).toBe(true)
      expect(isPathInTsconfigScope(root, join(root, "scratch/out.ts"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      resetTsconfigScopeCache()
    }
  })

  it("returns false for paths outside the workspace root", () => {
    resetTsconfigScopeCache()
    const root = fixture({ files: { "src/a.ts": "export {}\n" } })
    try {
      expect(isPathInTsconfigScope(root, "/tmp/unrelated.ts")).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      resetTsconfigScopeCache()
    }
  })
})
