/**
 * Decode/encode Cursor MCP exec round-trip (ExecServerMessage ↔ ExecClientMessage).
 *
 * Cursor AgentService/Run is bidi: after `tool_call_started` on interaction_update,
 * the server sends `exec_server_message { mcp_args }` and blocks until the client
 * writes `exec_client_message { mcp_result }` on the same HTTP/2 stream.
 *
 * @module llm/providers/cursor/proto/exec-mcp
 */

import { decodeMapEntry } from "./value-decode.ts"
import {
  concat,
  decodeFields,
  encBool,
  encMsg,
  encString,
  encVarintField,
  fieldBytes,
  fieldString,
} from "./wire.ts"

/** Parsed MCP exec request from ExecServerMessage.mcp_args. */
export type CursorMcpExecRequest = {
  execId: number
  execSessionId: string
  toolCallId: string
  providerIdentifier: string
  toolName: string
  args: Record<string, unknown>
}

const EXEC_MCP_ARGS_FIELD = 11
const EXEC_MCP_RESULT_FIELD = 11

/** Decode agent.v1.ExecServerMessage; returns MCP exec when mcp_args present. */
export function decodeExecServerMcpRequest(payload: Uint8Array): CursorMcpExecRequest | undefined {
  let execId = 0
  let execSessionId = ""
  let mcpBody: Uint8Array | undefined
  for (const f of decodeFields(payload)) {
    if (f.no === 1 && f.wire === 0) execId = Number(f.value ?? 0)
    if (f.no === 15) execSessionId = fieldString(f) ?? ""
    if (f.no === EXEC_MCP_ARGS_FIELD && f.wire === 2) mcpBody = fieldBytes(f) ?? undefined
  }
  if (!mcpBody) return undefined

  let toolCallId = ""
  let providerIdentifier = ""
  let toolName = ""
  const args: Record<string, unknown> = {}
  for (const f of decodeFields(mcpBody)) {
    if (f.no === 3) toolCallId = fieldString(f) ?? ""
    if (f.no === 4) providerIdentifier = fieldString(f) ?? ""
    if (f.no === 5) toolName = fieldString(f) ?? ""
    if (f.no === 2 && f.wire === 2) {
      const entryBody = fieldBytes(f)
      if (entryBody) {
        const entry = decodeMapEntry(entryBody)
        if (entry) args[entry.key] = entry.value
      }
    }
  }
  if (!toolName && !toolCallId) return undefined
  return { execId, execSessionId, toolCallId, providerIdentifier, toolName, args }
}

/** Encode agent.v1.McpTextContent (text field). */
function encMcpTextContent(text: string): Uint8Array {
  return encString(1, text)
}

/** Encode agent.v1.McpSuccess (content list + optional is_error). */
function encMcpSuccess(content: string, isError = false): Uint8Array {
  const parts = [encMsg(1, encMcpTextContent(content))]
  if (isError) parts.push(encBool(2, true))
  return concat(...parts)
}

/** Encode agent.v1.McpError (error string). */
function encMcpError(message: string): Uint8Array {
  return encString(1, message)
}

/** Encode agent.v1.McpResult success or error oneof. */
export function encMcpResult(opts: { content: string; isError?: boolean }): Uint8Array {
  if (opts.isError) {
    return encMsg(2, encMcpError(opts.content))
  }
  return encMsg(1, encMcpSuccess(opts.content, false))
}

/** Encode agent.v1.ExecClientMessage with mcp_result. */
export function encodeExecClientMcpResult(
  req: Pick<CursorMcpExecRequest, "execId" | "execSessionId">,
  result: { content: string; isError?: boolean },
): Uint8Array {
  const parts: Uint8Array[] = [
    encVarintField(1, req.execId),
    encString(15, req.execSessionId),
    encMsg(EXEC_MCP_RESULT_FIELD, encMcpResult(result)),
  ]
  return concat(...parts)
}

/** Wrap ExecClientMessage in AgentClientMessage (field 2 exec_client_message). */
export function encodeAgentClientExecMessage(execClientBody: Uint8Array): Uint8Array {
  return encMsg(2, execClientBody)
}
