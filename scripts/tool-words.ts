#!/usr/bin/env bun
/**
 * Word budget report for the tool block.
 *
 * Reads the shipped tools (`shippedTools`: the widest request golden, which
 * is what the model receives, plus every manifest tool that the golden does
 * not have) and prints the words of each tool against its `TOOL_WORDS` entry,
 * the block total (golden tools only) and the block budget. Use it as the feedback loop while you cut text: edit
 * the source, regenerate the golden, and read the new number. Every count is
 * `budgetWords` (a raw whitespace split), the same count as the test.
 *
 * Usage:
 *   bun run scripts/tool-words.ts            # ranked table plus the total
 *   bun run scripts/tool-words.ts --tool Bash  # one tool, in full
 *
 * @module scripts/tool-words
 */

import {
  blockWords,
  LOOSE_WORDS,
  PER_TOOL_LOOSE,
  shippedTools,
  TARGET,
  TOOL_BLOCK_WORDS,
  TOOL_WORDS,
  toolWords,
} from "../tests/ste/tool-budget.ts"

const tools = shippedTools()
const rows = toolWords(tools)
const total = blockWords(rows)
const argIndex = process.argv.indexOf("--tool")
const only = argIndex >= 0 ? process.argv[argIndex + 1] : undefined

/**
 * The status of one tool against its entry.
 *
 * @param words - Measured words.
 * @param entry - The `TOOL_WORDS` entry, or undefined.
 * @returns A short mark.
 */
function mark(words: number, entry: number | undefined): string {
  if (entry === undefined) return "NO ENTRY"
  if (words > entry) return `OVER by ${words - entry}`
  if (entry - words > PER_TOOL_LOOSE) return `LOOSE by ${entry - words}: lower the entry`
  return ""
}

if (only) {
  const row = rows.find((r) => r.name === only)
  if (!row) {
    console.error(`no tool named ${only}`)
    process.exit(1)
  }
  const found = tools.find((t) => t.name === only)?.description ?? ""
  const entry = TOOL_WORDS[only]
  console.log(
    `${only}: ${row.words} words, entry ${entry ?? "none"}, source ${row.source}  ${mark(row.words, entry)}\n`,
  )
  console.log(found)
} else {
  console.log(
    `total  ${total} words   budget ${TOOL_BLOCK_WORDS} (loose ${LOOSE_WORDS})   ${total > TOOL_BLOCK_WORDS ? `OVER by ${total - TOOL_BLOCK_WORDS}` : `under by ${TOOL_BLOCK_WORDS - total}`}`,
  )
  console.log(
    `per tool: entry from TOOL_WORDS, loose ${PER_TOOL_LOOSE}, target ${TARGET.words} (${TARGET.owner})\n`,
  )
  console.log(`${"words".padStart(5)}  ${"entry".padStart(5)}  ${"delta".padStart(5)}  tool`)
  for (const row of [...rows].sort((a, b) => b.words - a.words)) {
    const entry = TOOL_WORDS[row.name]
    const delta = entry === undefined ? "" : String(row.words - entry)
    const target = row.words > TARGET.words ? "  >target" : ""
    const source = row.source === "manifest" ? "  (manifest only: not in the block total)" : ""
    const status = mark(row.words, entry)
    console.log(
      `${String(row.words).padStart(5)}  ${String(entry ?? "-").padStart(5)}  ${delta.padStart(5)}  ${row.name}${target}${source}${status ? `  ${status}` : ""}`,
    )
  }
  const shipped = new Set(rows.map((r) => r.name))
  const stale = Object.keys(TOOL_WORDS).filter((name) => !shipped.has(name))
  if (stale.length > 0) console.log(`\nentries for tools that do not ship: ${stale.join(", ")}`)
}
