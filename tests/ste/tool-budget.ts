/**
 * Word budget for the tool block, which ships on every request.
 *
 * The STE rules judge how a sentence is written. They do not judge how much
 * text ships. The first STE pass grew the tool block by 5.1% (+404 words,
 * about +350 tokens on every request), and no rule could see it.
 *
 * @module tests/ste/tool-budget
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { PLUGINS_ROOT } from "./surfaces.ts"

/** The widest golden: the built-in tools plus the plugin fixture tools. */
const GOLDEN = join(PLUGINS_ROOT, "tests/request-golden/goldens/plugin-handler-throws.json")

/**
 * Total words for the whole tool block, measured 2026-11-16.
 *
 * HEAD (before the STE pass) was 7910, and the pass grew it to 8314. It was cut
 * to 7900 by removing repetition, but that cut dropped facts the reviewer
 * caught. Amanda's decision: facts beat the budget. The facts are restored and
 * the budget is set to the measured value. The ratchet blocks growth from here.
 * Lower it by hand after a real cut. The lower tolerance stops it sitting
 * loose.
 */
export const TOOL_BLOCK_WORDS = 8163

/**
 * The largest a single tool may be, measured 2026-11-16.
 *
 * `Computer` is the worst at 751 words, after the reviewer restored the
 * meanings of 8 of its enum values. This is a ceiling, not a target: cut the
 * biggest tools by hand and lower this number with each cut. The long-run
 * target is 250, but never at the cost of a rule or a fact.
 */
export const PER_TOOL_MAX = 751

/** How far below a budget the tree may drift before the budget must be lowered. */
export const LOOSE_WORDS = 200

/** Tools that exist only in a test fixture, so they are not shipped text. */
const FIXTURE_ONLY = new Set(["FixtureThrow"])

/** A tool with its description and its parameter descriptions. */
interface ToolText {
  name: string
  words: number
}

/**
 * Read one golden and count the words of each tool block.
 *
 * The count covers the tool `description` and every nested `description` in
 * its `input_schema`, which is what the model receives.
 *
 * @param path - Golden path.
 * @returns One entry for each shipped tool, sorted by name.
 */
export function toolWords(path: string = GOLDEN): ToolText[] {
  const golden = JSON.parse(readFileSync(path, "utf8")) as unknown
  const found = new Map<string, number>()

  const count = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + count(item), 0)
    if (!value || typeof value !== "object") return 0
    let words = 0
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "description" && typeof child === "string") {
        words += child.split(/\s+/).filter(Boolean).length
      } else {
        words += count(child)
      }
    }
    return words
  }

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (!value || typeof value !== "object") return
    const node = value as Record<string, unknown>
    if (
      typeof node.name === "string" &&
      node.input_schema &&
      typeof node.description === "string"
    ) {
      if (!FIXTURE_ONLY.has(node.name)) {
        // `count` sums `description` words in a tree; a bare string has no
        // `description` key, so the tool description is counted directly.
        const own = (node.description as string).split(/\s+/).filter(Boolean).length
        const total = own + count(node.input_schema)
        found.set(node.name, Math.max(found.get(node.name) ?? 0, total))
      }
    }
    for (const child of Object.values(node)) walk(child)
  }

  walk(golden)
  return [...found.entries()]
    .map(([name, words]) => ({ name, words }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
