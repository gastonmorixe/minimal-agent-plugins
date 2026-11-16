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

const FILES = [
  "identity.neutral.md",
  "instructions.md",
  "loop-safety/ack.md",
  "loop-safety/checkpoint-cooldown.tmpl.md",
  "loop-safety/checkpoint-plain.tmpl.md",
  "loop-safety/heading.md",
  "loop-safety/intro.md",
  "tool-output-conventions.md",
]

for (const name of FILES) {
  run(`${name} is byte identical to the core asset${note}`, () => {
    const mine = readFileSync(join(import.meta.dir, "prompts", name))
    expect(mine.equals(readFileSync(join(CORE, name)))).toBe(true)
  })
}
