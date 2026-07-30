/**
 * Unit tests for Cursor MCP tool wire policy.
 */

import { describe, expect, test } from "bun:test"

import { cursorCaps } from "./capabilities.ts"
import {
  CURSOR_BUILTIN_TOOL_CATALOG,
  CURSOR_MCP_TOOL_ONEOF,
  cursorBuiltinToolsToExclude,
} from "./cursor-builtin-tools.ts"
import {
  buildCursorToolWirePolicy,
  CURSOR_EXCLUDE_TOOLS_HEADER,
  CURSOR_MA_MCP_PROVIDER_ID,
  cursorToolsEnabledOnWire,
  maToolToCursorMcpWire,
} from "./cursor-tool-policy.ts"
import { decodeFields, fieldBytes, fieldString } from "./proto/wire.ts"
import { buildCursorAgentRunBody, buildCursorToolHeaders } from "./request-body.ts"
import { CURSOR_SURFACE_AGENT_RUN } from "./wire-constants.ts"

const model = {
  id: "cursor-auto",
  providerId: "cursor",
  surfaceId: CURSOR_SURFACE_AGENT_RUN,
  displayName: "Auto",
  capabilities: cursorCaps(),
  pricing: {
    inputUSD: 0,
    outputUSD: 0,
    cacheWriteUSD: 0,
    cacheReadUSD: 0,
    webSearchPerCallUSD: 0,
  },
  vendorIds: { cursor: "default" },
}

describe("cursor tool policy", () => {
  test("exclude list omits mcpToolCall when MCP tools enabled", () => {
    const exclude = cursorBuiltinToolsToExclude(true)
    expect(exclude).not.toContain(CURSOR_MCP_TOOL_ONEOF)
    expect(exclude).toContain("grepToolCall")
    expect(exclude).toContain("shellToolCall")
    expect(exclude.length).toBe(CURSOR_BUILTIN_TOOL_CATALOG.length - 1)
  })

  test("exclude list includes mcpToolCall when tools disabled", () => {
    const exclude = cursorBuiltinToolsToExclude(false)
    expect(exclude).toContain(CURSOR_MCP_TOOL_ONEOF)
  })

  test("maps MA tools to MCP wire rows", () => {
    const wire = maToolToCursorMcpWire({
      name: "ModelInfo",
      description: "Session model info",
      inputSchema: { type: "object", properties: {} },
    })
    expect(wire.providerIdentifier).toBe(CURSOR_MA_MCP_PROVIDER_ID)
    expect(wire.toolName).toBe("ModelInfo")
    expect(wire.name).toBe("minimal-agent-ModelInfo")
    expect(JSON.parse(wire.inputSchemaJson)).toEqual({ type: "object", properties: {} })
  })

  test("toolChoice none disables MCP encode but still excludes built-ins", () => {
    expect(
      cursorToolsEnabledOnWire({
        modelId: "cursor-auto",
        messages: [],
        tools: [{ name: "Read", description: "x", inputSchema: { type: "object" } }],
        toolChoice: { type: "none" },
      }),
    ).toBe(false)
    const headers = buildCursorToolHeaders({
      modelId: "cursor-auto",
      messages: [],
      tools: [{ name: "Read", description: "x", inputSchema: { type: "object" } }],
      toolChoice: { type: "none" },
    })
    expect(headers[CURSOR_EXCLUDE_TOOLS_HEADER]).toContain(CURSOR_MCP_TOOL_ONEOF)
  })

  test("AgentRunRequest encodes mcp_tools field 4 when tools present", () => {
    const body = buildCursorAgentRunBody(
      {
        modelId: "cursor-auto",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [
          {
            name: "ModelInfo",
            description: "Model metadata",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
      model,
    )
    const outer = decodeFields(body)
    const run = fieldBytes(outer.find((f) => f.no === 1)!)
    const runFields = decodeFields(run!)
    const mcpField = runFields.find((f) => f.no === 4)
    expect(mcpField).toBeTruthy()
    const mcpBody = fieldBytes(mcpField!)
    expect(mcpBody).toBeTruthy()
    const mcpInner = decodeFields(mcpBody!)
    const toolDef = fieldBytes(mcpInner.find((f) => f.no === 1)!)
    expect(toolDef).toBeTruthy()
    const tdFields = decodeFields(toolDef!)
    expect(fieldString(tdFields.find((f) => f.no === 1)!)).toBe("minimal-agent-ModelInfo")
    expect(fieldString(tdFields.find((f) => f.no === 5)!)).toBe("ModelInfo")
  })

  test("buildCursorToolWirePolicy attaches exclude header", () => {
    const policy = buildCursorToolWirePolicy({
      modelId: "cursor-auto",
      messages: [],
      tools: [{ name: "Grep", description: "search", inputSchema: { type: "object" } }],
    })
    expect(policy.mcpTools).toHaveLength(1)
    expect(policy.headers[CURSOR_EXCLUDE_TOOLS_HEADER]).toBeTruthy()
    expect(policy.headers[CURSOR_EXCLUDE_TOOLS_HEADER]).not.toContain(CURSOR_MCP_TOOL_ONEOF)
  })
})
