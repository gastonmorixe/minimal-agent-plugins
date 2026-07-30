/**
 * Encode agent.v1.McpResult / McpSuccess for ExecClientMessage.mcp_result.
 *
 * @module llm/providers/cursor/proto/mcp-result
 */

import { concat, encBoolExplicit, encMsg, encString } from "./wire.ts"

/** Encode agent.v1.McpTextContent (field 1 = text). */
export function encMcpTextContent(text: string): Uint8Array {
  return encString(1, text)
}

/** Encode McpToolResultContentItem with text oneof (field 1). */
export function encMcpToolResultContentItemText(text: string): Uint8Array {
  return encMsg(1, encMcpTextContent(text))
}

/** Encode agent.v1.McpSuccess. */
export function encMcpSuccess(text: string, isError = false): Uint8Array {
  return concat(encMsg(1, encMcpToolResultContentItemText(text)), encBoolExplicit(2, isError))
}

/** Encode agent.v1.McpError. */
export function encMcpError(message: string): Uint8Array {
  return encString(1, message)
}

/** Encode agent.v1.McpResult with success oneof (field 1). */
export function encMcpResultSuccess(text: string, isError = false): Uint8Array {
  return encMsg(1, encMcpSuccess(text, isError))
}

/** Encode agent.v1.McpResult with error oneof (field 2). */
export function encMcpResultError(message: string): Uint8Array {
  return encMsg(2, encMcpError(message))
}
