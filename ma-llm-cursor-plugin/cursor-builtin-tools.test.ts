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
      "create_goal_tool_call",
      "update_goal_tool_call",
      "adopt_tool_call",
      "get_agent_status_tool_call",
      "send_to_agent_tool_call",
      "read_agent_transcript_tool_call",
      "create_agent_tool_call",
      "stop_agent_tool_call",
      "get_pr_code_tour_tool_call",
      "write_canvas_tool_call",
      "read_canvas_tool_call",
    ]) {
      expect(exclude).toContain(name)
      expect(isValidCursorBuiltinToolName(name)).toBe(true)
    }
  })

  test("mcpToolCall stays allowed", () => {
    expect(cursorBuiltinToolsToExclude(true)).not.toContain("mcp_tool_call")
    expect(cli.some((r) => r.oneof_case === CURSOR_MCP_TOOL_ONEOF)).toBe(true)
  })
})
