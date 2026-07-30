/**
 * Encode agent.v1.McpTools / McpToolDefinition for AgentRunRequest.mcp_tools.
 *
 * Uses `input_schema_json` (field 6) instead of Struct — simpler and matches
 * the Cursor client's JSON path for client-defined MCP schemas.
 *
 * @module llm/providers/cursor/proto/mcp-tools
 */

import { concat, encMsg, encString } from "./wire.ts"

/** Wire-ready MCP tool row (already normalized for Cursor). */
export type CursorMcpToolWire = {
  /** Composite wire name (`${providerIdentifier}-${toolName}`). */
  name: string
  providerIdentifier: string
  toolName: string
  description: string
  inputSchemaJson: string
}

/** Encode one agent.v1.McpToolDefinition. */
export function encMcpToolDefinition(tool: CursorMcpToolWire): Uint8Array {
  return concat(
    encString(1, tool.name),
    encString(2, tool.description),
    encString(4, tool.providerIdentifier),
    encString(5, tool.toolName),
    encString(6, tool.inputSchemaJson),
  )
}

/** Encode agent.v1.McpTools container (repeated mcp_tools). */
export function encMcpTools(tools: readonly CursorMcpToolWire[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const tool of tools) {
    parts.push(encMsg(1, encMcpToolDefinition(tool)))
  }
  return concat(...parts)
}
