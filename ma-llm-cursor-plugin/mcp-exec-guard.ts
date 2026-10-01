/**
 * Guard for MCP exec requests that name a tool MA never registered.
 *
 * The allowlist keeps `get_mcp_tools_tool_call` on, so the server shows the
 * model its GetDynamicTools / CallDynamicTool bridge. The model then calls
 * those names. They ride `exec_server_message.mcp_args` like real MA tools, but
 * MA has no such tool, and the host answered "Unknown tool". Answer them on the
 * wire instead: the model gets the real tool list and tries again.
 *
 * @module llm/providers/cursor/mcp-exec-guard
 */

import type { DecodedExecMcpArgs } from "./proto/exec-server-decode.ts"
import { decodeAgentServerExec } from "./proto/exec-server-decode.ts"
import type { CursorMcpToolWire } from "./proto/mcp-tools.ts"

/** Bridge tool the model uses to list MCP tools. */
const LIST_BRIDGE_TOOL = "GetDynamicTools"

/** An MCP exec for a tool MA does not have, with the reply text to send. */
export type UnregisteredMcpExec = {
  exec: DecodedExecMcpArgs
  replyText: string
  /** True when the reply is a normal result (tool list), false for an error. */
  ok: boolean
}

function toolCatalogText(tools: readonly CursorMcpToolWire[]): string {
  const rows = tools.map(
    (t) => `- ${t.toolName}: ${t.description.split("\n")[0]?.slice(0, 160) ?? ""}`,
  )
  return [
    `Available tools (call each one directly by its exact name, no wrapper tool):`,
    ...rows,
  ].join("\n")
}

/**
 * Return a reply when `payload` is an MCP exec (mcp_args) whose tool is not in
 * `tools`. Native execs (shell, read, ...) and registered tools return undefined.
 */
export function findUnregisteredMcpExec(
  payload: Uint8Array,
  tools: readonly CursorMcpToolWire[],
): UnregisteredMcpExec | undefined {
  const exec = decodeAgentServerExec(payload)
  if (!exec || exec.nativeExecFieldNo !== undefined) return undefined
  const name = exec.maToolName ?? exec.toolName
  if (!name) return undefined
  if (tools.some((t) => t.toolName === name)) return undefined
  if (name === LIST_BRIDGE_TOOL) {
    return { exec, ok: true, replyText: toolCatalogText(tools) }
  }
  return {
    exec,
    ok: false,
    replyText: `Tool "${name}" does not exist. ${toolCatalogText(tools)}`,
  }
}
