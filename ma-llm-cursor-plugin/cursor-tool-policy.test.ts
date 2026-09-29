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
  CURSOR_ALLOWED_TOOLS_HEADER,
  CURSOR_EXCLUDE_TOOLS_HEADER,
  CURSOR_MA_MCP_PROVIDER_ID,
  cursorToolsEnabledOnWire,
  learnCursorRequiredTool,
  maToolToCursorMcpWire,
  requiredToolFromCursorError,
  resetCursorLearnedToolsForTests,
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
  test("exclude list omits mcp_tool_call when MCP tools enabled", () => {
    const exclude = cursorBuiltinToolsToExclude(true)
    expect(exclude).not.toContain("mcp_tool_call")
    expect(exclude).toContain("grep_tool_call")
    expect(exclude).toContain("shell_tool_call")
    expect(exclude.length).toBe(CURSOR_BUILTIN_TOOL_CATALOG.length - 1)
  })

  test("exclude list includes mcp_tool_call when tools disabled", () => {
    const exclude = cursorBuiltinToolsToExclude(false)
    expect(exclude).toContain("mcp_tool_call")
  })

  // The official CLI validates --exclude-tools against ToolCall.fields[].name
  // (snake_case) and joins those names into x-cursor-agent-exclude-tools
  // (6949.index.js exclude-tools.ts + exclude-tools-headers.ts, 2026.09.28).
  test("exclude header uses snake_case proto names, never camelCase oneof cases", () => {
    const exclude = cursorBuiltinToolsToExclude(true)
    for (const token of exclude) expect(token).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*_tool_call$/)
    expect(exclude).not.toContain(CURSOR_MCP_TOOL_ONEOF)
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
    expect(headers[CURSOR_EXCLUDE_TOOLS_HEADER]?.split(",")).toContain("mcp_tool_call")
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

  // Live A/B 2026-09-28 (research/cursor-regression/eric-repro/06-tool-surface-ab.md):
  // the exclude header does not hide native tools from the model's prompt, but
  // an allowlist does. The server requires get_mcp_tools_tool_call (GetDynamicTools)
  // and kills the Run without it ("Required tool GET_MCP_TOOLS not found").
  test("MCP enabled: allowlist only mcp_tool_call + get_mcp_tools_tool_call, no exclude", () => {
    const policy = buildCursorToolWirePolicy({
      modelId: "cursor-auto",
      messages: [],
      tools: [{ name: "Grep", description: "search", inputSchema: { type: "object" } }],
    })
    expect(policy.headers[CURSOR_ALLOWED_TOOLS_HEADER]?.split(",").sort()).toEqual([
      "get_mcp_tools_tool_call",
      "mcp_tool_call",
    ])
    expect(policy.headers[CURSOR_EXCLUDE_TOOLS_HEADER]).toBeUndefined()
  })

  test("MCP disabled (toolChoice none): no allowlist, full exclude list", () => {
    const policy = buildCursorToolWirePolicy({
      modelId: "cursor-auto",
      messages: [],
      tools: [{ name: "Grep", description: "search", inputSchema: { type: "object" } }],
      toolChoice: { type: "none" },
    })
    expect(policy.headers[CURSOR_ALLOWED_TOOLS_HEADER]).toBeUndefined()
    expect(policy.headers[CURSOR_EXCLUDE_TOOLS_HEADER]?.split(",")).toContain("mcp_tool_call")
  })

  test("kill switch MA_CURSOR_TOOL_FILTER=exclude restores the exclude list", () => {
    const prev = process.env.MA_CURSOR_TOOL_FILTER
    process.env.MA_CURSOR_TOOL_FILTER = "exclude"
    try {
      const policy = buildCursorToolWirePolicy({
        modelId: "cursor-auto",
        messages: [],
        tools: [{ name: "Grep", description: "search", inputSchema: { type: "object" } }],
      })
      expect(policy.headers[CURSOR_ALLOWED_TOOLS_HEADER]).toBeUndefined()
      const exclude = policy.headers[CURSOR_EXCLUDE_TOOLS_HEADER]?.split(",") ?? []
      expect(exclude).toContain("shell_tool_call")
      expect(exclude).not.toContain("mcp_tool_call")
    } finally {
      if (prev === undefined) delete process.env.MA_CURSOR_TOOL_FILTER
      else process.env.MA_CURSOR_TOOL_FILTER = prev
    }
  })

  test("allowlist accepts extra server-required tools (self-heal)", () => {
    const policy = buildCursorToolWirePolicy(
      {
        modelId: "cursor-auto",
        messages: [],
        tools: [{ name: "Grep", description: "search", inputSchema: { type: "object" } }],
      },
      { extraAllowedTools: ["create_plan_tool_call", "mcp_tool_call"] },
    )
    expect(policy.headers[CURSOR_ALLOWED_TOOLS_HEADER]?.split(",").sort()).toEqual([
      "create_plan_tool_call",
      "get_mcp_tools_tool_call",
      "mcp_tool_call",
    ])
  })

  test("requiredToolFromCursorError maps the server enum to a snake_case oneof", () => {
    expect(
      requiredToolFromCursorError(
        "cursor connect end-stream: internal: Required tool GET_MCP_TOOLS not found in allTools",
      ),
    ).toBe("get_mcp_tools_tool_call")
    expect(requiredToolFromCursorError("Required tool CREATE_PLAN not found in allTools")).toBe(
      "create_plan_tool_call",
    )
    expect(requiredToolFromCursorError("Required tool ASK_QUESTION not found in allTools")).toBe(
      "ask_question_tool_call",
    )
    // Unknown enum (not in the catalog): no guess.
    expect(requiredToolFromCursorError("Required tool NOPE_NOPE not found in allTools")).toBe(
      undefined,
    )
    expect(requiredToolFromCursorError("unauthenticated")).toBeUndefined()
  })

  test("a learned required tool is allowed on every later Run until reset", () => {
    resetCursorLearnedToolsForTests()
    try {
      expect(learnCursorRequiredTool("create_plan_tool_call")).toBe(true)
      expect(learnCursorRequiredTool("create_plan_tool_call")).toBe(false)
      const policy = buildCursorToolWirePolicy({
        modelId: "cursor-auto",
        messages: [],
        tools: [{ name: "Grep", description: "search", inputSchema: { type: "object" } }],
      })
      expect(policy.headers[CURSOR_ALLOWED_TOOLS_HEADER]?.split(",")).toContain(
        "create_plan_tool_call",
      )
    } finally {
      resetCursorLearnedToolsForTests()
    }
  })

  test("buildCursorToolWirePolicy still encodes MA tools as MCP rows", () => {
    const policy = buildCursorToolWirePolicy({
      modelId: "cursor-auto",
      messages: [],
      tools: [{ name: "Grep", description: "search", inputSchema: { type: "object" } }],
    })
    expect(policy.mcpTools).toHaveLength(1)
    expect(policy.mcpTools[0]?.toolName).toBe("Grep")
  })
})
