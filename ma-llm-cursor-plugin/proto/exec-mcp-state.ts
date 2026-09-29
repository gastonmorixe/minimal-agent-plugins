/**
 * Cursor MCP state exec (ExecServerMessage.mcp_state_exec_args #36).
 *
 * Before Cursor exposes client MCP tools to the model, the server asks the
 * client which MCP servers and tools it has. The official CLI answers with
 * `mcp-state-executor`: `ExecClientMessage.mcp_state_exec_result` (#36) =
 * `McpStateExecResult.success` = `McpStateSuccess { servers[] }`. If the
 * client does not answer, the server waits and the turn hangs (observed live
 * on CLI build 2026.09.28-64d2043).
 *
 * Descriptors (2026.09.28 bundle):
 * - `McpStateExecArgs|1 server_identifiers 9*|2 kick_only 8`
 * - `McpStateExecResult|1 success|2 error|3 rejected`
 * - `McpStateSuccess|1 servers*`
 * - `McpStateServer|1 server_name|2 server_identifier|3 plugin?|4 marketplace?|5 tools*|6 instructions*|7 status?|8 error_message?`
 *
 * @module llm/providers/cursor/proto/exec-mcp-state
 */

import { CURSOR_MA_MCP_PROVIDER_ID } from "../cursor-tool-policy.ts"

import { type CursorMcpToolWire, encMcpToolDefinition } from "./mcp-tools.ts"
import {
  concat,
  decodeFields,
  encMsg,
  encString,
  encVarintField,
  fieldBytes,
  fieldString,
} from "./wire.ts"

const EXEC_MCP_STATE_FIELD = 36

/** Parsed `ExecServerMessage` carrying `mcp_state_exec_args`. */
export type DecodedExecMcpState = {
  id: number
  execId: string
  serverIdentifiers: string[]
  kickOnly: boolean
}

/** Decode an ExecServerMessage body. Returns undefined unless #36 is set. */
export function decodeExecServerMcpState(body: Uint8Array): DecodedExecMcpState | undefined {
  let id = 0
  let execId = ""
  let args: Uint8Array | undefined
  for (const f of decodeFields(body)) {
    if (f.no === 1 && f.wire === 0) id = Number(f.value ?? 0)
    if (f.no === 15 && f.wire === 2) execId = fieldString(f) ?? execId
    if (f.no === EXEC_MCP_STATE_FIELD && f.wire === 2) args = fieldBytes(f) ?? new Uint8Array(0)
  }
  if (!args) return undefined
  const serverIdentifiers: string[] = []
  let kickOnly = false
  for (const f of decodeFields(args)) {
    if (f.no === 1 && f.wire === 2) {
      const s = fieldString(f)
      if (s) serverIdentifiers.push(s)
    }
    if (f.no === 2 && f.wire === 0) kickOnly = Number(f.value ?? 0) !== 0
  }
  return { id, execId, serverIdentifiers, kickOnly }
}

/** Decode a top-level AgentServerMessage. Returns the mcp_state request, if any. */
export function decodeAgentServerMcpState(payload: Uint8Array): DecodedExecMcpState | undefined {
  for (const f of decodeFields(payload)) {
    if (f.no === 2 && f.wire === 2) {
      const body = fieldBytes(f)
      if (body) return decodeExecServerMcpState(body)
    }
  }
  return undefined
}

/** Encode one McpStateServer for the MA MCP provider. */
function encMcpStateServer(tools: readonly CursorMcpToolWire[]): Uint8Array {
  return concat(
    encString(1, CURSOR_MA_MCP_PROVIDER_ID),
    encString(2, CURSOR_MA_MCP_PROVIDER_ID),
    ...tools.map((t) => encMsg(5, encMcpToolDefinition(t))),
    // Official mapper values: connected | needsAuth | error | loading.
    encString(7, "connected"),
  )
}

/**
 * Encode `AgentClientMessage.exec_client_message.mcp_state_exec_result`.
 *
 * Mirrors the official executor: one server row per MCP provider, filtered to
 * the requested identifiers when the server names any. `kick_only` still gets
 * a full reply (the official client only skips the load wait).
 */
export function encodeAgentClientMcpStateResult(
  req: Pick<DecodedExecMcpState, "id" | "execId">,
  tools: readonly CursorMcpToolWire[],
  requestedIds: readonly string[] = [],
): Uint8Array {
  const wanted = requestedIds.length === 0 || requestedIds.includes(CURSOR_MA_MCP_PROVIDER_ID)
  const servers = wanted ? [encMsg(1, encMcpStateServer(tools))] : []
  const success = concat(...servers)
  const result = encMsg(1, success)
  const exec = concat(
    encVarintField(1, req.id),
    ...(req.execId ? [encString(15, req.execId)] : []),
    encMsg(EXEC_MCP_STATE_FIELD, result),
  )
  return encMsg(2, exec)
}
