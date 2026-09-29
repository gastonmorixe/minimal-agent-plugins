/**
 * Drift guard: the hand-kept ToolCall oneof catalog must match the catalog
 * extracted from the real Cursor CLI bundle. When Cursor adds a tool, this
 * test fails and the exclude header would otherwise leak the new tool.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import {
  CURSOR_BUILTIN_TOOL_CATALOG,
  CURSOR_MCP_TOOL_ONEOF,
  cursorBuiltinToolsToExclude,
  isValidCursorBuiltinToolName,
} from "./cursor-builtin-tools.ts"

type CliRow = { field_number: number; proto_name: string; oneof_case: string }

const SNAPSHOT = "toolcall-oneof-catalog.cli-2026.09.28-64d2043.json"
const cli: CliRow[] = JSON.parse(
  readFileSync(join(import.meta.dir, "__fixtures__", SNAPSHOT), "utf8"),
)

describe("cursor builtin tool catalog vs CLI snapshot", () => {
  test("snapshot is non-trivial", () => {
    expect(cli.length).toBeGreaterThanOrEqual(69)
  })

  test("every CLI oneof is in the plugin catalog (no leak)", () => {
    const ours = new Set(CURSOR_BUILTIN_TOOL_CATALOG.map((e) => e.oneofCase))
    const missing = cli.filter((r) => !ours.has(r.oneof_case)).map((r) => r.oneof_case)
    expect(missing).toEqual([])
  })

  test("plugin catalog has no entry unknown to the CLI", () => {
    const theirs = new Set(cli.map((r) => r.oneof_case))
    const extra = CURSOR_BUILTIN_TOOL_CATALOG.filter((e) => !theirs.has(e.oneofCase)).map(
      (e) => e.oneofCase,
    )
    expect(extra).toEqual([])
  })

  test("field numbers and proto names match", () => {
    const byCase = new Map(CURSOR_BUILTIN_TOOL_CATALOG.map((e) => [e.oneofCase, e]))
    for (const r of cli) {
      const e = byCase.get(r.oneof_case)
      expect(e?.fieldNumber).toBe(r.field_number)
      expect(e?.protoName).toBe(r.proto_name)
    }
  })

  test("new July-to-Sept oneofs 70-80 are excluded when MCP is enabled", () => {
    const exclude = cursorBuiltinToolsToExclude(true)
    for (const name of [
      "createGoalToolCall",
      "updateGoalToolCall",
      "adoptToolCall",
      "getAgentStatusToolCall",
      "sendToAgentToolCall",
      "readAgentTranscriptToolCall",
      "createAgentToolCall",
      "stopAgentToolCall",
      "getPrCodeTourToolCall",
      "writeCanvasToolCall",
      "readCanvasToolCall",
    ]) {
      expect(exclude).toContain(name)
      expect(isValidCursorBuiltinToolName(name)).toBe(true)
    }
  })

  test("mcpToolCall stays allowed", () => {
    expect(cursorBuiltinToolsToExclude(true)).not.toContain(CURSOR_MCP_TOOL_ONEOF)
    expect(cli.some((r) => r.oneof_case === CURSOR_MCP_TOOL_ONEOF)).toBe(true)
  })
})
