/**
 * Cursor tool wire policy: MA tools via MCP, native oneofs excluded.
 *
 * Cursor AgentService/Run does not accept arbitrary JSON tool schemas on the
 * built-in ToolCall oneofs. Client-defined tools must ride `mcp_tools` +
 * `mcp_tool_call`. Native grep/shell/read/etc. are filtered with
 * `x-cursor-agent-exclude-tools`.
 *
 * @module llm/providers/cursor/cursor-tool-policy
 */

import { cursorBuiltinToolsToExclude } from "./cursor-builtin-tools.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { CanonicalToolDefinition } from "./lib/canonical-tools.ts"
import { isServerTool } from "./lib/canonical-tools.ts"
import type { CursorMcpToolWire } from "./proto/mcp-tools.ts"

/** Stable MCP provider id for minimal-agent tools on the Cursor wire. */
export const CURSOR_MA_MCP_PROVIDER_ID = "minimal-agent"

export const CURSOR_EXCLUDE_TOOLS_HEADER = "x-cursor-agent-exclude-tools"
export const CURSOR_ALLOWED_TOOLS_HEADER = "x-cursor-agent-allowed-tools"

/** Resolved wire policy for one AgentService/Run request. */
export type CursorToolWirePolicy = {
  /** User tools encoded for AgentRunRequest.mcp_tools (empty when tools disabled). */
  mcpTools: CursorMcpToolWire[]
  /** HTTP headers for built-in tool filtering. */
  headers: Record<string, string>
  /** User tools after stripping server-hosted entries. */
  userTools: CanonicalToolDefinition[]
}

/** True when the request should advertise / allow MCP tool calls. */
export function cursorToolsEnabledOnWire(req: CanonicalRequest): boolean {
  if (!req.tools?.length) return false
  if (req.toolChoice?.type === "none") return false
  return true
}

/** Filter to user-executable tools (drop provider server tools). */
export function cursorUserTools(req: CanonicalRequest): CanonicalToolDefinition[] {
  return (req.tools ?? []).filter((t) => !isServerTool(t))
}

/**
 * Map one MA {@link CanonicalToolDefinition} to Cursor McpToolDefinition wire row.
 */
export function maToolToCursorMcpWire(
  tool: CanonicalToolDefinition,
  providerId = CURSOR_MA_MCP_PROVIDER_ID,
): CursorMcpToolWire {
  const toolName = tool.name
  return {
    name: `${providerId}-${toolName}`,
    providerIdentifier: providerId,
    toolName,
    description: tool.description,
    inputSchemaJson: JSON.stringify(tool.inputSchema ?? { type: "object", properties: {} }),
  }
}

/**
 * Build MCP rows + exclude-tool headers for one canonical request.
 */
export function buildCursorToolWirePolicy(req: CanonicalRequest): CursorToolWirePolicy {
  const userTools = cursorUserTools(req)
  const enabled = cursorToolsEnabledOnWire(req)
  const exclude = cursorBuiltinToolsToExclude(enabled)
  const headers: Record<string, string> = {}
  if (exclude.length > 0) {
    headers[CURSOR_EXCLUDE_TOOLS_HEADER] = exclude.join(",")
  }
  const mcpTools = enabled ? userTools.map((t) => maToolToCursorMcpWire(t)) : []
  return { mcpTools, headers, userTools }
}
