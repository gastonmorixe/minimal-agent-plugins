/**
 * Guard: no file imports core from a sibling checkout.
 *
 * Some tests need a core module that has no public subpath. They import it
 * through the installed package directory, with a path that starts at this
 * repo: `../node_modules/@minimal-agent/core/src/x.ts`.
 *
 * They must not import it from a checkout next to this repo, with a path that
 * leaves this repo: `../../minimal-agent-core/src/x.ts`.
 *
 * The second form works only in the umbrella monorepo, where the sibling
 * checkout and the installed package are the same directory. In a standalone
 * clone it has two bad outcomes. With no sibling checkout, the typecheck
 * fails. With one, the process has two copies of core (the checkout and the
 * installed pin), and core refuses to load the second copy.
 *
 * The first form resolves to the one core that this repo installs, in both
 * layouts: the local checkout in the umbrella, the pinned commit in a
 * standalone clone.
 *
 * A file that reads core files as data (for example a text audit that walks
 * `../minimal-agent-core`) is not an import and is not checked here. Such a
 * test must skip when the checkout is not there.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

const REPO_ROOT = join(import.meta.dir, "..")

/** An import, export-from or dynamic import whose path goes up to a `minimal-agent-core` directory. */
const SIBLING_IMPORT =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](?:\.\.\/)+minimal-agent-core\//

/** A line that is only a comment: `//`, `/*` or the ` *` of a block comment. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/

/** Return "file:line" for each code line of `source` that imports core from a sibling checkout. */
function siblingImports(file: string, source: string): string[] {
  const found: string[] = []
  for (const [i, line] of source.split("\n").entries()) {
    if (COMMENT_LINE.test(line)) continue
    if (SIBLING_IMPORT.test(line)) found.push(`${file}:${i + 1}`)
  }
  return found
}

describe("no sibling core imports", () => {
  test("the pattern finds each import form and ignores other text", () => {
    // Built at run time, so this file has no line that the scan below reports.
    const dir = ["minimal", "agent", "core"].join("-")
    const hit = [
      `import { a } from "../../${dir}/src/a.ts"`,
      `} from '../../../${dir}/plugin-api/src/b.ts'`,
      `export { c } from "../../${dir}/src/c.ts"`,
      `const d = await import("../../${dir}/src/d.ts")`,
      `import "../../${dir}/src/e.ts"`,
    ]
    for (const line of hit) expect(siblingImports("x.ts", line)).toEqual(["x.ts:1"])

    const miss = [
      `import { a } from "../node_modules/@minimal-agent/core/src/a.ts"`,
      `import { b } from "@minimal-agent/core/plugin-api/types/b"`,
      `const root = join(here, "..", "${dir}", "src")`,
      `const file = "../../${dir}/src/data.jsonl"`,
      ` *   import { e } from "../../${dir}/src/e.ts"`,
      `// import { f } from "../../${dir}/src/f.ts"`,
    ]
    for (const line of miss) expect(siblingImports("x.ts", line)).toEqual([])
  })

  test("no .ts file imports core from a sibling checkout", () => {
    const glob = new Bun.Glob("**/*.ts")
    const found: string[] = []
    for (const path of glob.scanSync({ cwd: REPO_ROOT, onlyFiles: true })) {
      const parts = path.split("/")
      if (parts.includes("node_modules") || parts[0] === "tmp") continue
      found.push(...siblingImports(path, readFileSync(join(REPO_ROOT, path), "utf8")))
    }
    expect(found).toEqual([])
  })
})
