/**
 * S42 guard: no plugin file may be a copy of a core plugin-api file.
 *
 * Plugins import shared helpers from `@minimal-agent/core/plugin-api/*`.
 * A local copy drifts from core and hides from the "vendored" marker scan.
 * This test hashes every `.ts` file in this repo and every `.ts` file in the
 * installed core `plugin-api/src`. It compares the code with comments and
 * blank lines removed, so a copy with an edited comment also fails.
 */

import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

import { describe, expect, test } from "bun:test"

const REPO_ROOT = join(import.meta.dir, "..")

/** Files with less code than this are too small to count as a copy. */
const MIN_CODE_CHARS = 200

/** Remove comments and blank lines, then trim each line end. */
function normalizeCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n")
}

function codeHash(code: string): string {
  return createHash("sha256").update(code).digest("hex")
}

function listTsFiles(root: string): string[] {
  const glob = new Bun.Glob("**/*.ts")
  const out: string[] = []
  for (const path of glob.scanSync({ cwd: root, onlyFiles: true })) {
    if (path.split("/").includes("node_modules")) continue
    out.push(join(root, path))
  }
  return out
}

/** Map code hash to core file path for every core plugin-api file. */
function coreHashes(coreSrc: string): Map<string, string> {
  const hashes = new Map<string, string>()
  for (const file of listTsFiles(coreSrc)) {
    const code = normalizeCode(readFileSync(file, "utf8"))
    if (code.length < MIN_CODE_CHARS) continue
    hashes.set(codeHash(code), relative(coreSrc, file))
  }
  return hashes
}

/** Return "plugin file == core file" for each copy found. */
function findCopies(pluginFiles: string[], core: Map<string, string>): string[] {
  const copies: string[] = []
  for (const file of pluginFiles) {
    const code = normalizeCode(readFileSync(file, "utf8"))
    if (code.length < MIN_CODE_CHARS) continue
    const match = core.get(codeHash(code))
    if (match !== undefined) copies.push(`${relative(REPO_ROOT, file)} == plugin-api/src/${match}`)
  }
  return copies
}

const coreSrc = join(
  dirname(Bun.resolveSync("@minimal-agent/core/package.json", REPO_ROOT)),
  "plugin-api",
  "src",
)

describe("no vendored core plugin-api copies (S42)", () => {
  test("core plugin-api source is present", () => {
    expect(coreHashes(coreSrc).size).toBeGreaterThan(10)
  })

  test("no plugin .ts file matches a core plugin-api file", () => {
    expect(findCopies(listTsFiles(REPO_ROOT), coreHashes(coreSrc))).toEqual([])
  })

  test("negative control: a core file with an edited comment is caught", () => {
    const dir = mkdtempSync(join(tmpdir(), "s42-guard-"))
    try {
      const source = readFileSync(join(coreSrc, "utils", "ansi.ts"), "utf8")
      const planted = join(dir, "ansi.ts")
      writeFileSync(planted, `// local note\n${source.replace("/**", "/** edited")}`)
      const copies = findCopies([planted], coreHashes(coreSrc))
      expect(copies).toHaveLength(1)
      expect(copies[0]).toEndWith("== plugin-api/src/utils/ansi.ts")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
