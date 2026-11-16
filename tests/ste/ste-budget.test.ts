/**
 * The tool block word budget, as a test.
 *
 * The budget itself lives in `tool-budget.ts` so a script can read it without
 * starting the test runner. This file only asserts it.
 *
 * @module tests/ste/ste-budget.test
 */

import { describe, expect, test } from "bun:test"

import { LOOSE_WORDS, PER_TOOL_MAX, TOOL_BLOCK_WORDS, toolWords } from "./tool-budget.ts"

describe("tool block word budget", () => {
  const tools = toolWords()
  const total = tools.reduce((sum, tool) => sum + tool.words, 0)

  test("the golden yields the shipped tool block", () => {
    expect(tools.length).toBeGreaterThan(40)
    expect(tools.some((tool) => tool.name === "Bash")).toBe(true)
    expect(tools.some((tool) => tool.name === "FixtureThrow")).toBe(false)
  })

  test("the total tool block is within budget", () => {
    expect(total, `total ${total} > budget ${TOOL_BLOCK_WORDS}`).toBeLessThanOrEqual(
      TOOL_BLOCK_WORDS,
    )
  })

  test("the budget is not loose", () => {
    // A budget far above the real count lets the text grow back. When the tree
    // is well under, lower the constant.
    expect(
      TOOL_BLOCK_WORDS - total,
      `the tree is ${TOOL_BLOCK_WORDS - total} words under budget. Lower TOOL_BLOCK_WORDS.`,
    ).toBeLessThanOrEqual(LOOSE_WORDS)
  })

  test("no single tool is over the per-tool ceiling", () => {
    expect(tools.filter((tool) => tool.words > PER_TOOL_MAX)).toEqual([])
  })

  test("the per-tool ceiling is not loose", () => {
    const worst = tools.reduce((max, tool) => Math.max(max, tool.words), 0)
    expect(
      PER_TOOL_MAX - worst,
      `the worst tool is ${PER_TOOL_MAX - worst} words under the ceiling. Lower PER_TOOL_MAX.`,
    ).toBeLessThanOrEqual(LOOSE_WORDS)
  })
})
