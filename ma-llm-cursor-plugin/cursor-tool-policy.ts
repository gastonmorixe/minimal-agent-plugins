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

import { CURSOR_BUILTIN_TOOL_CATALOG, cursorBuiltinToolsToExclude } from "./cursor-builtin-tools.ts"
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
 * Built-ins the server requires in the allowlist when MA tools ride MCP.
 * `mcp_tool_call` carries the calls. `get_mcp_tools_tool_call` is the
 * GetDynamicTools meta tool: without it the server kills the Run with
 * "Required tool GET_MCP_TOOLS not found in allTools" (live, 2026-09-28).
 */
export const CURSOR_MCP_ALLOWLIST = ["mcp_tool_call", "get_mcp_tools_tool_call"] as const

/** `allow` (default): allowlist. `exclude`: legacy exclude list (kill switch). */
export type CursorToolFilterMode = "allow" | "exclude"

/** Read `MA_CURSOR_TOOL_FILTER`. Anything but `exclude` means `allow`. */
export function cursorToolFilterMode(env: NodeJS.ProcessEnv = process.env): CursorToolFilterMode {
  return env.MA_CURSOR_TOOL_FILTER?.trim().toLowerCase() === "exclude" ? "exclude" : "allow"
}

/** Options for {@link buildCursorToolWirePolicy}. */
export type CursorToolWirePolicyOptions = {
  /** Extra snake_case oneofs to allow (self-heal after a "Required tool" error). */
  extraAllowedTools?: readonly string[]
}

/**
 * Build MCP rows + tool-filter headers for one canonical request.
 *
 * With MA tools on, send an allowlist (`x-cursor-agent-allowed-tools`) and no
 * exclude list. The exclude header blocks calls, but the server still describes
 * every native tool to the model, while the allowlist hides them (live A/B,
 * research/cursor-regression/eric-repro/06-tool-surface-ab.md). With tools off,
 * or `MA_CURSOR_TOOL_FILTER=exclude`, send the exclude list as before.
 */
export function buildCursorToolWirePolicy(
  req: CanonicalRequest,
  opts: CursorToolWirePolicyOptions = {},
): CursorToolWirePolicy {
  const userTools = cursorUserTools(req)
  const enabled = cursorToolsEnabledOnWire(req)
  const headers: Record<string, string> = {}
  if (enabled && cursorToolFilterMode() === "allow") {
    const allowed = new Set<string>([
      ...CURSOR_MCP_ALLOWLIST,
      ...learnedRequiredTools,
      ...(opts.extraAllowedTools ?? []),
    ])
    headers[CURSOR_ALLOWED_TOOLS_HEADER] = [...allowed].join(",")
  } else {
    const exclude = cursorBuiltinToolsToExclude(enabled)
    if (exclude.length > 0) headers[CURSOR_EXCLUDE_TOOLS_HEADER] = exclude.join(",")
  }
  const mcpTools = enabled ? userTools.map((t) => maToolToCursorMcpWire(t)) : []
  return { mcpTools, headers, userTools }
}

/** Server tool enum (GET_MCP_TOOLS) to snake_case oneof, built from the catalog. */
const REQUIRED_TOOL_ENUM_TO_ONEOF: ReadonlyMap<string, string> = new Map(
  CURSOR_BUILTIN_TOOL_CATALOG.map((e) => [
    e.protoName.replace(/_tool_call$/, "").toUpperCase(),
    e.protoName,
  ]),
)

/**
 * Map a "Required tool X not found in allTools" server error to the snake_case
 * ToolCall oneof to allow. The server names the tool as an enum
 * (GET_MCP_TOOLS). Returns undefined when the message does not match or the
 * enum has no catalog entry, so the caller surfaces the error with no guess.
 */
export function requiredToolFromCursorError(message: string): string | undefined {
  const m = /Required tool ([A-Z0-9_]+) not found in allTools/.exec(message)
  return m?.[1] ? REQUIRED_TOOL_ENUM_TO_ONEOF.get(m[1]) : undefined
}

/**
 * Tools the server demanded this process (self-heal). Every later Run allows
 * them from the start, so only the first Run pays for a retry.
 */
const learnedRequiredTools = new Set<string>()

/** Remember a server-required tool. Returns false when it was already known. */
export function learnCursorRequiredTool(protoName: string): boolean {
  if (learnedRequiredTools.has(protoName)) return false
  learnedRequiredTools.add(protoName)
  return true
}

/** Test-only: forget learned tools. */
export function resetCursorLearnedToolsForTests(): void {
  learnedRequiredTools.clear()
}
