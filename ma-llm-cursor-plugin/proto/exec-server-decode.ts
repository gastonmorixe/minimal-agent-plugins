/**
 * Decode AgentServerMessage.exec_server_message (MCP tool execution requests).
 *
 * @module llm/providers/cursor/proto/exec-server-decode
 */

import { mapMcpToolToMaName } from "./tool-call-decode.ts"
import { decodeMapEntry } from "./value-decode.ts"
import { decodeFields, fieldBytes, fieldString } from "./wire.ts"

/** Parsed ExecServerMessage.mcp_args row. */
export type DecodedExecMcpArgs = {
  /** ExecServerMessage.id (field 1, uint64). */
  id: number
  /** ExecServerMessage.exec_id (field 15, string). */
  execId: string
  toolCallId: string
  providerIdentifier?: string
  toolName?: string
  maToolName?: string
  input?: Record<string, unknown>
  /** ExecServerMessage oneof field number (11=mcp, 2=shell, 5=grep, 7=read, 8=ls, …). */
  nativeExecFieldNo?: number
}

function decodeMcpArgsBody(body: Uint8Array): Omit<DecodedExecMcpArgs, "id" | "execId"> {
  let toolCallId = ""
  let providerIdentifier: string | undefined
  let toolName: string | undefined
  // Field 2 = map<string, Value>. Protobuf encodes each map entry as a
  // separate repeated field-2 message, so we must merge ALL entries.
  const input: Record<string, unknown> = {}
  let hasInput = false
  for (const f of decodeFields(body)) {
    if (f.no === 3) toolCallId = fieldString(f) ?? ""
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
  return {
    toolCallId,
    providerIdentifier,
    toolName,
    maToolName: mapMcpToolToMaName(providerIdentifier, toolName),
    input: hasInput ? input : undefined,
  }
}

/**
 * ExecServerMessage native exec oneof field numbers → MA tool name.
 *
 * Proto reference (agent.v1.ExecServerMessage):
 *   2=shell_args, 3=write_args, 4=delete_args, 5=grep_args,
 *   7=read_args, 8=ls_args, 9=diagnostics_args, 10=request_context_args,
 *   11=mcp_args, 14=shell_stream_args, 16=bg_shell_spawn_args,
 *   17=list_mcp_resources, 18=read_mcp_resource, 20=fetch_args,
 *   21=record_screen_args, 22=computer_use_args, 23=write_shell_stdin_args,
 *   27=execute_hook_args
 *
 * Most native args carry \{ tool_call_id: field 3 (string) \} and type-specific
 * payload fields. We extract the tool_call_id and map to the closest MA tool.
 */
const NATIVE_EXEC_FIELD_TO_MA_TOOL: ReadonlyMap<number, string> = new Map([
  [2, "Bash"], // shell_args
  [3, "Write"], // write_args
  [4, "Bash"], // delete_args (MA has no Delete; route to Bash)
  [5, "Grep"], // grep_args
  [7, "Read"], // read_args
  [8, "Glob"], // ls_args
  [9, "Bash"], // diagnostics_args
  [14, "Bash"], // shell_stream_args
  [20, "Fetch"], // fetch_args
])

/**
 * tool_call_id field number per native exec type.
 * ShellArgs=4, ReadArgs=2, LsArgs=3, GrepArgs=none, WriteArgs=?, DeleteArgs=?
 */
const TOOL_CALL_ID_FIELD: ReadonlyMap<number, number> = new Map([
  [2, 4], // shell_args → field 4
  [7, 2], // read_args → field 2
  [8, 3], // ls_args → field 3
  [14, 4], // shell_stream_args → field 4 (same layout as shell_args)
])

function extractNativeToolCallId(execFieldNo: number, argsBody: Uint8Array): string {
  const idField = TOOL_CALL_ID_FIELD.get(execFieldNo)
  if (!idField) return ""
  for (const f of decodeFields(argsBody)) {
    if (f.no === idField && f.wire === 2) {
      const s = fieldString(f)
      if (s) return s
    }
  }
  return ""
}

/** Decode native exec args into a simplified input object for the MA tool. */
function decodeNativeExecInput(fieldNo: number, argsBody: Uint8Array): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  switch (fieldNo) {
    case 2: // shell_args: field 1 = command (agent.v1.ShellArgs)
    case 14: // shell_stream_args: SAME ShellArgs type in Cursor proto (not a different shape)
      for (const f of decodeFields(argsBody)) {
        if (f.no === 1) input.command = fieldString(f) ?? ""
        if (f.no === 2) input.working_directory = fieldString(f) ?? undefined
      }
      break
    case 5: // grep_args: 1=pattern, 2=path, 3=glob, 4=output_mode, 8=case_insensitive
      for (const f of decodeFields(argsBody)) {
        if (f.no === 1) input.pattern = fieldString(f) ?? ""
        if (f.no === 2) input.path = fieldString(f) ?? undefined
        if (f.no === 3) input.glob = fieldString(f) ?? undefined
      }
      break
    case 7: // read_args: 1=path, 4=offset, 5=limit
      for (const f of decodeFields(argsBody)) {
        if (f.no === 1) input.file_path = fieldString(f) ?? ""
      }
      break
    case 8: {
      // ls_args: field 1 = path
      let path = "."
      for (const f of decodeFields(argsBody)) {
        if (f.no === 1) path = fieldString(f) ?? "."
      }
      const p = path === "." || path === "" ? "**/*" : `${path.replace(/\/$/, "")}/**/*`
      input.pattern = p
      input.path = path || "."
      break
    }
    case 3: // write_args: field 1 = path, field 2 = content
      for (const f of decodeFields(argsBody)) {
        if (f.no === 1) input.file_path = fieldString(f) ?? ""
        if (f.no === 2) input.content = fieldString(f) ?? ""
      }
      break
    case 20: // fetch_args: field 1 = url
      for (const f of decodeFields(argsBody)) {
        if (f.no === 1) input.url = fieldString(f) ?? ""
      }
      break
  }
  return input
}

/** Decode ExecServerMessage inner body (field 2 of AgentServerMessage). */
export function decodeExecServerMessageBody(body: Uint8Array): DecodedExecMcpArgs | undefined {
  let id = 0
  let execId = ""
  for (const f of decodeFields(body)) {
    if (f.no === 1 && f.wire === 0) id = Number(f.value ?? 0)
    if (f.no === 15) execId = fieldString(f) ?? execId
  }

  // MCP args (field 11) take priority — these are our own tools.
  const mcp = decodeExecServerMcpArgs(body)
  if (mcp) return mcp

  // Native exec oneofs: map to the closest MA tool.
  for (const f of decodeFields(body)) {
    if (f.wire !== 2) continue
    const maToolName = NATIVE_EXEC_FIELD_TO_MA_TOOL.get(f.no)
    if (!maToolName) continue
    const argsBody = fieldBytes(f)
    if (!argsBody) continue
    const toolCallId = extractNativeToolCallId(f.no, argsBody) || crypto.randomUUID()
    const input = decodeNativeExecInput(f.no, argsBody)
    // ShellArgs (fields 2 and 14 share agent.v1.ShellArgs): refuse empty command
    // so Bash never sees undefined and crashes on command.match.
    if ((f.no === 2 || f.no === 14) && !String(input.command ?? "").trim()) {
      continue
    }
    return {
      id,
      execId,
      toolCallId,
      toolName: maToolName,
      maToolName,
      input,
      nativeExecFieldNo: f.no,
    }
  }

  return undefined
}

/** Decode ExecServerMessage; returns MCP args when field 11 is set. */
export function decodeExecServerMcpArgs(body: Uint8Array): DecodedExecMcpArgs | undefined {
  let id = 0
  let execId = ""
  let mcpArgs: ReturnType<typeof decodeMcpArgsBody> | undefined
  for (const f of decodeFields(body)) {
    if (f.no === 1 && f.wire === 0) id = Number(f.value ?? 0)
    if (f.no === 1 && f.wire === 2) {
      const s = fieldString(f)
      if (s && !execId) execId = s
    }
    if (f.no === 15) execId = fieldString(f) ?? execId
    if (f.no === 11 && f.wire === 2) {
      const inner = fieldBytes(f)
      if (inner) mcpArgs = decodeMcpArgsBody(inner)
    }
  }
  if (!mcpArgs || !mcpArgs.toolCallId) return undefined
  return { id, execId, ...mcpArgs }
}

/** Decode top-level AgentServerMessage payload. */
export function decodeAgentServerMessage(payload: Uint8Array): {
  kind: "interaction_update" | "exec_server_mcp" | "other"
  interactionBody?: Uint8Array
  execMcp?: DecodedExecMcpArgs
} {
  for (const f of decodeFields(payload)) {
    if (f.no === 1 && f.wire === 2) {
      const body = fieldBytes(f)
      if (body) return { kind: "interaction_update", interactionBody: body }
    }
    if (f.no === 2 && f.wire === 2) {
      const body = fieldBytes(f)
      if (body) {
        const exec = decodeExecServerMessageBody(body)
        if (exec) return { kind: "exec_server_mcp", execMcp: exec }
      }
    }
  }
  return { kind: "other" }
}

/** Find exec_server_message on an AgentServerMessage payload (any exec oneof). */
export function decodeAgentServerExec(payload: Uint8Array): DecodedExecMcpArgs | undefined {
  for (const f of decodeFields(payload)) {
    if (f.no === 2 && f.wire === 2) {
      const body = fieldBytes(f)
      if (body) return decodeExecServerMessageBody(body)
    }
  }
  return undefined
}
