/**
 * Unit tests of {@link withoutAddedTools} (`golden-tool-additions.ts`). The
 * list `TOOL_ADDITIONS` is empty today, so these tests give their own list.
 * They moved out of `ste-golden-shape.test.ts` (max-lines).
 *
 * @module tests/ste/golden-tool-additions.test
 */

import { describe, expect, test } from "bun:test"

import { TOOL_ADDITIONS, type ToolAddition, withoutAddedTools } from "./golden-tool-additions.ts"

const NEW_TOOLS: readonly ToolAddition[] = [{ name: "NewTool", reason: "test", date: "2026-11-23" }]

const tool = (name: string, enumValues = ["a", "b"]) => ({
  name,
  description: `The ${name} tool.`,
  input_schema: {
    type: "object",
    properties: { mode: { type: "string", enum: enumValues } },
    required: ["mode"],
  },
})
const golden = (tools: unknown[]) => ({ requests: [{ tools, messages: [] }] })
const before = golden([tool("Alpha"), tool("Omega")])

describe("withoutAddedTools: TOOL_ADDITIONS (intended new tool)", () => {
  test("the list is empty: the current golden does not change", () => {
    expect(TOOL_ADDITIONS).toEqual([])
    const after = golden([tool("Alpha"), tool("NewTool"), tool("Omega")])
    expect(withoutAddedTools(before, after)).toBe(after)
  })

  test("an added listed tool goes, also in the middle of the array", () => {
    for (const after of [
      golden([tool("Alpha"), tool("NewTool"), tool("Omega")]),
      golden([tool("Alpha"), tool("Omega"), tool("NewTool")]),
    ]) {
      expect(withoutAddedTools(before, after, NEW_TOOLS)).toEqual(before)
    }
  })

  test("kills 'any tool': an added tool that is not listed stays", () => {
    const after = golden([tool("Alpha"), tool("Other"), tool("Omega")])
    expect(withoutAddedTools(before, after, NEW_TOOLS)).toEqual(after)
  })

  test("kills 'hides other changes': a change of another tool stays", () => {
    const after = golden([tool("Alpha", ["a", "c"]), tool("NewTool"), tool("Omega")])
    expect(withoutAddedTools(before, after, NEW_TOOLS)).toEqual(
      golden([tool("Alpha", ["a", "c"]), tool("Omega")]),
    )
  })

  test("kills 'hides a reorder': a new order of the other tools stays", () => {
    const after = golden([tool("Omega"), tool("NewTool"), tool("Alpha")])
    expect(withoutAddedTools(before, after, NEW_TOOLS)).toEqual(
      golden([tool("Omega"), tool("Alpha")]),
    )
  })

  test("a listed tool that the merge base has already stays", () => {
    const withNew = golden([tool("Alpha"), tool("NewTool")])
    const changed = golden([tool("Alpha"), tool("NewTool", ["x"])])
    expect(withoutAddedTools(withNew, changed, NEW_TOOLS)).toEqual(changed)
  })
})
