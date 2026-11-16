#!/usr/bin/env bun
/**
 * Word budget report for the tool block.
 *
 * Reads the widest request golden (what the model actually receives) and
 * prints the words of each tool, the total, and the budget. Use it as the
 * feedback loop while you cut text: edit the source, regenerate the golden,
 * and read the new number.
 *
 * Usage:
 *   bun run scripts/tool-words.ts            # ranked table plus the total
 *   bun run scripts/tool-words.ts --tool Bash  # one tool, in full
 *
 * @module scripts/tool-words
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { PER_TOOL_MAX, TOOL_BLOCK_WORDS, toolWords } from "../tests/ste/tool-budget.ts"

const GOLDEN = join(
  import.meta.dir,
  "..",
  "tests/request-golden/goldens/plugin-handler-throws.json",
)

const rows = toolWords(GOLDEN)
const total = rows.reduce((sum, row) => sum + row.words, 0)
const argIndex = process.argv.indexOf("--tool")
const only = argIndex >= 0 ? process.argv[argIndex + 1] : undefined

if (only) {
  const row = rows.find((r) => r.name === only)
  if (!row) {
    console.error(`no tool named ${only}`)
    process.exit(1)
  }
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as unknown
  let found = ""
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (!value || typeof value !== "object") return
    const node = value as Record<string, unknown>
    if (node.name === only && typeof node.description === "string") found = node.description
    for (const child of Object.values(node)) walk(child)
  }
  walk(golden)
  console.log(`${only}: ${row.words} words\n`)
  console.log(found)
} else {
  console.log(
    `total  ${total} words   budget ${TOOL_BLOCK_WORDS}   ${total > TOOL_BLOCK_WORDS ? `OVER by ${total - TOOL_BLOCK_WORDS}` : `under by ${TOOL_BLOCK_WORDS - total}`}`,
  )
  console.log(`per-tool ceiling ${PER_TOOL_MAX}\n`)
  for (const row of [...rows].sort((a, b) => b.words - a.words)) {
    const mark = row.words > PER_TOOL_MAX ? "  OVER" : ""
    console.log(`${String(row.words).padStart(5)}  ${row.name}${mark}`)
  }
}
