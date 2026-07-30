/**
 * Decode InteractionUpdate tool_call_* payloads into MA-friendly shapes.
 *
 * @module llm/providers/cursor/proto/tool-call-decode
 */

import { decodeMapEntry } from "./value-decode.ts"
import { decodeFields, fieldBytes, fieldString } from "./wire.ts"

/** MCP tool call extracted from a ToolCallStarted/Completed update. */
export type DecodedCursorMcpToolCall = {
  callId: string
  providerIdentifier?: string
  toolName?: string
  /** MA registry tool name when mappable. */
  maToolName?: string
  input?: Record<string, unknown>
  /** Built-in oneof case when not MCP (should be excluded on wire). */
  builtinOneof?: string
}

const MCP_TOOL_CALL_FIELD = 15

/** Map MCP provider+tool back to MA canonical tool name. */
export function mapMcpToolToMaName(
  providerIdentifier: string | undefined,
  toolName: string | undefined,
  providerId = "minimal-agent",
): string | undefined {
  if (!toolName) return undefined
  if (providerIdentifier && providerIdentifier !== providerId) return toolName
  return toolName
}

function decodeMcpArgs(body: Uint8Array): {
  providerIdentifier?: string
  toolName?: string
  input?: Record<string, unknown>
} {
  let providerIdentifier: string | undefined
  let toolName: string | undefined
  const input: Record<string, unknown> = {}
  let hasInput = false
  for (const f of decodeFields(body)) {
    if (f.no === 4) providerIdentifier = fieldString(f) ?? undefined
    if (f.no === 5) toolName = fieldString(f) ?? undefined
    if (f.no === 2 && f.wire === 2) {
      const entryBody = fieldBytes(f)
      if (entryBody) {
        const entry = decodeMapEntry(entryBody)
        if (entry) {
          input[entry.key] = entry.value
          hasInput = true
        }
      }
    }
  }
  return { providerIdentifier, toolName, input: hasInput ? input : undefined }
}

function decodeToolCallMessage(body: Uint8Array): DecodedCursorMcpToolCall | undefined {
  for (const f of decodeFields(body)) {
    if (f.wire !== 2) continue
    const inner = fieldBytes(f)
    if (!inner) continue
    if (f.no === MCP_TOOL_CALL_FIELD) {
      for (const mf of decodeFields(inner)) {
        if (mf.no === 1 && mf.wire === 2) {
          const argsBody = fieldBytes(mf)
          if (!argsBody) continue
          const args = decodeMcpArgs(argsBody)
          return {
            callId: "",
            providerIdentifier: args.providerIdentifier,
            toolName: args.toolName,
            maToolName: mapMcpToolToMaName(args.providerIdentifier, args.toolName),
            input: args.input,
            builtinOneof: "mcpToolCall",
          }
        }
      }
    }
    // Any other oneof = native Cursor built-in (grep, shell, …).
    const entry = CURSOR_ONEOF_BY_FIELD.get(f.no)
    if (entry) {
      return { callId: "", builtinOneof: entry, toolName: entry, maToolName: entry }
    }
  }
  return undefined
}

/** field no → oneof case for quick native-tool detection. */
const CURSOR_ONEOF_BY_FIELD = new Map<number, string>([
  [1, "shellToolCall"],
  [3, "deleteToolCall"],
  [4, "globToolCall"],
  [5, "grepToolCall"],
  [8, "readToolCall"],
  [9, "updateTodosToolCall"],
  [10, "readTodosToolCall"],
  [12, "editToolCall"],
  [13, "lsToolCall"],
  [14, "readLintsToolCall"],
  [16, "semSearchToolCall"],
  [17, "createPlanToolCall"],
  [18, "webSearchToolCall"],
  [19, "taskToolCall"],
  [24, "fetchToolCall"],
])

/**
 * Decode ToolCallStartedUpdate (InteractionUpdate field 2) or
 * ToolCallCompletedUpdate (field 3).
 */
export function decodeToolCallUpdate(body: Uint8Array): DecodedCursorMcpToolCall | undefined {
  let callId: string | undefined
  let decoded: DecodedCursorMcpToolCall | undefined
  for (const f of decodeFields(body)) {
    if (f.no === 1) callId = fieldString(f) ?? undefined
    if (f.no === 2 && f.wire === 2) {
      const tc = fieldBytes(f)
      if (tc) decoded = decodeToolCallMessage(tc)
    }
  }
  if (!decoded) return undefined
  return { ...decoded, callId: callId ?? decoded.callId ?? crypto.randomUUID() }
}
