/** Byte parity with the core asset files. Drop this file when the core assets leave. */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "bun:test"

const CORE = join(import.meta.dir, "..", "..", "minimal-agent-core", "src", "prompts")

for (const name of ["identity.neutral.md", "instructions.md"]) {
  test(`${name} is byte identical to the core asset`, () => {
    const mine = readFileSync(join(import.meta.dir, "prompts", name))
    expect(mine.equals(readFileSync(join(CORE, name)))).toBe(true)
  })
}
