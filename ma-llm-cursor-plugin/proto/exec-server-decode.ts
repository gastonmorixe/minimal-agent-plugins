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

/**
 * ExecServerMessage args oneof, field number to proto name (CLI 2026.09.28-64d2043
 * descriptor). Used only to name exec kinds that MA cannot answer.
 */
const EXEC_ARGS_ONEOF_NAMES: ReadonlyMap<number, string> = new Map([
  [2, "shell_args"],
  [3, "write_args"],
  [4, "delete_args"],
  [5, "grep_args"],
  [7, "read_args"],
  [8, "ls_args"],
  [9, "diagnostics_args"],
  [10, "request_context_args"],
  [11, "mcp_args"],
  [14, "shell_stream_args"],
  [16, "background_shell_spawn_args"],
  [17, "list_mcp_resources_exec_args"],
  [18, "read_mcp_resource_exec_args"],
  [20, "fetch_args"],
  [21, "record_screen_args"],
  [22, "computer_use_args"],
  [23, "write_shell_stdin_args"],
  [27, "execute_hook_args"],
  [28, "subagent_args"],
  [29, "redacted_read_args"],
  [30, "force_background_shell_args"],
  [31, "force_background_subagent_args"],
  [36, "mcp_state_exec_args"],
  [37, "subagent_await_args"],
  [38, "smart_mode_classifier_args"],
  [40, "canvas_diagnostics_args"],
  [41, "shell_allowlist_precheck_args"],
  [42, "mcp_allowlist_precheck_args"],
  [43, "web_fetch_allowlist_precheck_args"],
  [44, "git_diff_request"],
  [45, "pi_read_args"],
  [46, "pi_bash_args"],
  [47, "pi_edit_args"],
  [48, "pi_write_args"],
  [49, "pi_grep_args"],
  [50, "pi_find_args"],
  [51, "pi_ls_args"],
  [52, "mini_swe_agent_bash_args"],
  [53, "conversation_search_args"],
  [54, "agent_store_conflict_args"],
  [56, "adopt_args"],
])

/** ExecServerMessage.id (#1) of an AgentServerMessage exec frame, or 0. */
export function decodeAgentServerExecId(payload: Uint8Array): number {
  for (const f of decodeFields(payload)) {
    if (f.no !== 2 || f.wire !== 2) continue
    const body = fieldBytes(f)
    if (!body) return 0
    for (const g of decodeFields(body)) {
      if (g.no === 1 && g.wire === 0) return Number(g.value ?? 0)
    }
    return 0
  }
  return 0
}

/** Exec field numbers MA answers outside the native mapper (mcp_state has its own reply). */
const EXEC_HANDLED_ELSEWHERE: ReadonlySet<number> = new Set([36])

/** An exec request MA has no handler for. */
export type UnsupportedExec = { fieldNo: number; name: string }

/**
 * Return the exec kind when an AgentServerMessage carries an exec request that
 * MA cannot answer. That covers kinds with no MA mapping, and mapped kinds that
 * the decoder refuses (for example a shell exec with an empty command). The
 * caller must reply, or the server waits forever.
 */
export function findUnsupportedExec(payload: Uint8Array): UnsupportedExec | undefined {
  for (const f of decodeFields(payload)) {
    if (f.no !== 2 || f.wire !== 2) continue
    const body = fieldBytes(f)
    if (!body) return undefined
    if (decodeExecServerMessageBody(body)) return undefined
    for (const g of decodeFields(body)) {
      if (g.wire !== 2 || EXEC_HANDLED_ELSEWHERE.has(g.no)) continue
      const name = EXEC_ARGS_ONEOF_NAMES.get(g.no)
      if (name) return { fieldNo: g.no, name }
    }
    return undefined
  }
  return undefined
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
