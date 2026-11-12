/**
 * Byte parity with the core asset files. Drop this file when the core assets leave.
 * It reads the sibling core checkout. When that folder is absent (a plugins-only
 * clone) the cases are skipped with the reason in their name.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "bun:test"

const CORE = join(import.meta.dir, "..", "..", "minimal-agent-core", "src", "prompts")
const HAS_CORE = existsSync(CORE)
const run = HAS_CORE ? test : test.skip
const note = HAS_CORE ? "" : " (skipped: the sibling core checkout is absent)"

for (const name of ["identity.neutral.md", "instructions.md"]) {
  run(`${name} is byte identical to the core asset${note}`, () => {
    const mine = readFileSync(join(import.meta.dir, "prompts", name))
    expect(mine.equals(readFileSync(join(CORE, name)))).toBe(true)
  })
}
