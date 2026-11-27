/**
 * Unit tests of {@link withoutAddedTools} (`golden-tool-additions.ts`). The
 * list `TOOL_ADDITIONS` is empty today, so these tests give their own list.
 * They moved out of `ste-golden-shape.test.ts` (max-lines).
 *
 * @module tests/ste/golden-tool-additions.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import {
  TOOL_ADDITIONS,
  TOOL_SCHEMA_CHANGES,
  type ToolAddition,
  type ToolSchemaChange,
  withoutAddedTools,
  withoutSchemaChanges,
} from "./golden-tool-additions.ts"
import { PLUGINS_ROOT } from "./surfaces.ts"

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

const CHANGES: readonly ToolSchemaChange[] = [
  {
    tool: "Alpha",
    addedProperties: [{ name: "size", schema: { type: "number" } }],
    enums: [{ property: "mode", from: ["a", "b"], to: ["a", "b", "c"] }],
    reason: "test",
    date: "2026-11-27",
  },
]

/** A tool with an extra property next to `mode`. */
const withProp = (name: string, enumValues: string[], extra: Record<string, unknown>) => {
  const t = tool(name, enumValues)
  return {
    ...t,
    input_schema: { ...t.input_schema, properties: { ...t.input_schema.properties, ...extra } },
  }
}

describe("withoutSchemaChanges: TOOL_SCHEMA_CHANGES (intended schema change)", () => {
  test("a listed new property and enum change are undone", () => {
    const after = golden([
      withProp("Alpha", ["a", "b", "c"], { size: { type: "number" } }),
      tool("Omega"),
    ])
    expect(withoutSchemaChanges(before, after, CHANGES)).toEqual(before)
  })

  test("kills 'any property': a new property that is not listed stays", () => {
    const after = golden([
      withProp("Alpha", ["a", "b"], { other: { type: "number" } }),
      tool("Omega"),
    ])
    expect(withoutSchemaChanges(before, after, CHANGES)).toEqual(after)
  })

  test("kills 'any enum': an enum change that is not listed stays", () => {
    const after = golden([tool("Alpha", ["a", "x"]), tool("Omega")])
    expect(withoutSchemaChanges(before, after, CHANGES)).toEqual(after)
  })

  test("kills 'any tool': the same change in another tool stays", () => {
    const after = golden([tool("Alpha"), withProp("Omega", ["a", "b", "c"], { size: {} })])
    expect(withoutSchemaChanges(before, after, CHANGES)).toEqual(after)
  })

  test("a property that the merge base has already stays", () => {
    const old = golden([withProp("Alpha", ["a", "b"], { size: { type: "number" } })])
    const changed = golden([withProp("Alpha", ["a", "b"], { size: { type: "string" } })])
    expect(withoutSchemaChanges(old, changed, CHANGES)).toEqual(changed)
  })

  test("the listed schema matches with any key order (the goldens sort keys)", () => {
    const changes: readonly ToolSchemaChange[] = [
      {
        ...CHANGES[0],
        addedProperties: [{ name: "size", schema: { type: "number", description: "d" } }],
      } as ToolSchemaChange,
    ]
    const after = golden([
      withProp("Alpha", ["a", "b"], { size: { description: "d", type: "number" } }),
      tool("Omega"),
    ])
    expect(withoutSchemaChanges(before, after, changes)).toEqual(before)
  })

  test("kills 'any shape': a listed new property with a different schema stays", () => {
    for (const size of [
      { type: "string" },
      { type: "number", enum: [1, 2] },
      { type: "number", description: "x" },
      {},
    ]) {
      const after = golden([withProp("Alpha", ["a", "b"], { size }), tool("Omega")])
      expect(withoutSchemaChanges(before, after, CHANGES)).toEqual(after)
    }
  })

  test("each listed Computer property has the schema that the manifest ships", () => {
    const manifest = JSON.parse(
      readFileSync(join(PLUGINS_ROOT, "ma-computer-use-plugin/manifest.json"), "utf8"),
    ) as {
      headless: {
        tools: Array<{
          trigger: { tool: { input_schema: { properties: Record<string, unknown> } } }
        }>
      }
    }
    const props = manifest.headless.tools[0]?.trigger.tool.input_schema.properties ?? {}
    const change = TOOL_SCHEMA_CHANGES.find((c) => c.tool === "Computer")
    for (const p of change?.addedProperties ?? []) expect(props[p.name]).toEqual(p.schema as never)
  })

  test("an empty list does not change the golden", () => {
    const after = golden([tool("Alpha", ["a", "b", "c"])])
    expect(withoutSchemaChanges(before, after, [])).toBe(after)
  })
})
