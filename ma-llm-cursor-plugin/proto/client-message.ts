/**
 * Encode agent.v1.AgentClientMessage variants (run + exec tool results).
 *
 * @module llm/providers/cursor/proto/client-message
 */

import { encMcpResultError, encMcpResultSuccess } from "./mcp-result.ts"
import { encMsg, encString, encVarintField } from "./wire.ts"

/** Options for ExecClientMessage → mcp_result or native result. */
export type ExecMcpResultOpts = {
  /** ExecServerMessage.id (field 1, uint64). */
  id: number
  /** ExecServerMessage.exec_id (field 15, string). */
  execId: string
  /** Tool output text for result content. */
  resultText: string
  isError?: boolean
  /**
   * ExecServerMessage oneof field number that triggered this exec.
   * When set to a native exec field (2=shell, 5=grep, 7=read, 8=ls, etc.)
   * the result is encoded in the matching native *Result type instead of
   * mcp_result (field 11). Undefined or 11 → mcp_result.
   */
  nativeExecFieldNo?: number
}

/** Encode ExecClientMessage with the appropriate result oneof. */
export function encExecClientMessageResult(opts: ExecMcpResultOpts): Uint8Array {
  const parts: Uint8Array[] = []
  if (opts.id > 0) parts.push(encVarintField(1, opts.id))
  if (opts.execId) parts.push(encString(15, opts.execId))

  const fieldNo = opts.nativeExecFieldNo
  // shell_stream_args (14) must not use this unary path — see encodeShellStreamExecFrames.
  if (fieldNo && fieldNo !== 11 && fieldNo !== 14) {
    parts.push(encMsg(fieldNo, encNativeResult(fieldNo, opts)))
  } else if (fieldNo === 14) {
    // Fallback if a caller uses the unary helper: one stdout event only.
    parts.push(encMsg(14, encShellStreamStdout(opts.resultText)))
  } else {
    const result = opts.isError
      ? encMcpResultError(opts.resultText)
      : encMcpResultSuccess(opts.resultText, false)
    parts.push(encMsg(11, result))
  }
  return concatBytes(...parts)
}

/**
 * Cursor's ExecClientMessage.shell_stream (field 14) is a stream of ShellStream
 * events (start → stdout/stderr → exit), not a ShellResult. Mirror the official
 * client: one ExecClientMessage per event, then stream_close.
 */
export function encodeShellStreamExecFrames(opts: ExecMcpResultOpts): Uint8Array[] {
  const wrap = (shellStreamBody: Uint8Array): Uint8Array => {
    const execParts: Uint8Array[] = []
    if (opts.id > 0) execParts.push(encVarintField(1, opts.id))
    if (opts.execId) execParts.push(encString(15, opts.execId))
    execParts.push(encMsg(14, shellStreamBody))
    return encMsg(2, concatBytes(...execParts))
  }

  if (opts.isError) {
    // ShellStream.rejected (field 5) { command:1, working_directory:2, reason:3 }
    return [
      wrap(encMsg(5, concat(encString(1, ""), encString(2, ""), encString(3, opts.resultText)))),
    ]
  }

  return [
    // start (field 4) — empty sandbox_policy is fine
    wrap(encMsg(4, new Uint8Array(0))),
    // stdout (field 1) { data:1 }
    wrap(encShellStreamStdout(opts.resultText)),
    // exit (field 3) { code:1, cwd:2 }
    wrap(encMsg(3, concat(encVarintField(1, 0), encString(2, "")))),
  ]
}

function encShellStreamStdout(data: string): Uint8Array {
  return encMsg(1, encString(1, data))
}

/**
 * Encode GrepSuccess with tool output preserved in workspace_results.
 *
 * MA tools return ripgrep-style text; Cursor's GrepSuccess has no top-level
 * text field, so we stuff the blob into one GrepContentMatch under a single
 * workspace map entry. That is enough for the model to see grep output.
 */
function encGrepSuccessContent(resultText: string): Uint8Array {
  const contentMatch = concat(
    encVarintField(1, 1), // line_number
    encString(2, resultText), // content
  )
  const fileMatch = concat(
    encString(1, ""), // file
    encMsg(2, contentMatch), // matches (repeated)
  )
  const contentResult = concat(
    encMsg(1, fileMatch), // matches (repeated GrepFileMatch)
    encVarintField(2, 1), // total_lines
    encVarintField(3, 1), // total_matched_lines
  )
  const unionResult = encMsg(3, contentResult) // GrepUnionResult.content
  // map<string, GrepUnionResult> entry: key=1, value=2
  const mapEntry = concat(encString(1, "."), encMsg(2, unionResult))
  return concat(
    encString(1, ""), // pattern
    encString(3, "content"), // output_mode
    encMsg(4, mapEntry), // workspace_results
  )
}

/**
 * Encode a native typed result for ExecClientMessage.
 *
 * Each native result type wraps a success message in a `success` oneof (field 1).
 * The inner success message carries the tool output in its primary string field.
 */
function encNativeResult(fieldNo: number, opts: ExecMcpResultOpts): Uint8Array {
  if (opts.isError) {
    return encNativeError(fieldNo, opts.resultText)
  }
  switch (fieldNo) {
    case 2: // shell_result → ShellSuccess { stdout: field 5 }
      return encMsg(
        1,
        concat(
          encString(1, ""), // command
          encString(2, ""), // working_directory
          encVarintField(3, 0), // exit_code
          encString(5, opts.resultText), // stdout
        ),
      )
    case 5: {
      // grep_result → GrepSuccess (agent.v1 from cursor-agent 2026.07.23):
      //   1=pattern, 2=path, 3=output_mode,
      //   4=workspace_results map<string, GrepUnionResult>,
      //   5=active_editor_result GrepUnionResult
      // GrepUnionResult.content (field 3) → GrepContentResult.matches →
      // GrepFileMatch.matches → GrepContentMatch.content (field 2).
      return encMsg(1, encGrepSuccessContent(opts.resultText))
    }
    case 7: // read_result → ReadSuccess { content: field 2 }
      return encMsg(
        1,
        concat(
          encString(1, ""), // path
          encString(2, opts.resultText), // content (oneof output, field 2)
          encVarintField(3, 0), // total_lines
        ),
      )
    case 8: // ls_result → LsSuccess { directory_tree_root: field 1 (message) }
      // LsSuccess wraps a LsDirectoryTreeNode. Simplify: encode absPath.
      return encMsg(1, encMsg(1, encString(1, opts.resultText)))
    default:
      // Fallback: wrap as mcp_result
      return opts.isError
        ? encMcpResultError(opts.resultText)
        : encMcpResultSuccess(opts.resultText, false)
  }
}

function encNativeError(fieldNo: number, errorText: string): Uint8Array {
  // All native result types use field 2 = error message with { error: field 1 (string) }
  switch (fieldNo) {
    case 2: // ShellResult.failure (field 2) { command:1, wd:2, exit_code:3, stderr:6 }
      return encMsg(
        2,
        concat(encString(1, ""), encString(2, ""), encVarintField(3, 1), encString(6, errorText)),
      )
    case 5: // GrepResult.error (field 2) { error: field 1 }
      return encMsg(2, encString(1, errorText))
    case 7: // ReadResult.error (field 2) { path: field 1, error: field 2 }
      return encMsg(2, concat(encString(1, ""), encString(2, errorText)))
    case 8: // LsResult.error (field 2) { path: field 1, error: field 2 }
      return encMsg(2, concat(encString(1, ""), encString(2, errorText)))
    default:
      return encMsg(2, encString(1, errorText))
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return concatBytes(...parts)
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Deprecated alias for encExecClientMessageResult. @deprecated Use encExecClientMessageResult instead. */
export function encExecClientMessageMcpResult(opts: ExecMcpResultOpts): Uint8Array {
  return encExecClientMessageResult(opts)
}

/** Wrap ExecClientMessage in AgentClientMessage (field 2). */
export function encodeAgentClientMessageExecResult(opts: ExecMcpResultOpts): Uint8Array {
  return encMsg(2, encExecClientMessageResult(opts))
}

/** Deprecated alias for encodeAgentClientMessageExecResult. @deprecated Use encodeAgentClientMessageExecResult instead. */
export function encodeAgentClientMessageExecMcpResult(opts: ExecMcpResultOpts): Uint8Array {
  return encodeAgentClientMessageExecResult(opts)
}

/** Encode ExecClientControlMessage.stream_close wrapped in AgentClientMessage (field 5). */
export function encodeAgentClientMessageExecStreamClose(execNumericId: number): Uint8Array {
  const streamCloseBody = execNumericId > 0 ? encVarintField(1, execNumericId) : new Uint8Array(0)
  const controlBody = encMsg(1, streamCloseBody)
  return encMsg(5, controlBody)
}

/**
 * Encode AgentClientMessage.client_heartbeat (field 7).
 *
 * Official Cursor Agent CLI writes this empty message every 5s on the keep-open
 * AgentService/Run stream. Without it the server can finish text and then sit
 * silent — no `turn_ended`, HTTP/2 body still open, TUI stuck on
 * "Receiving stream".
 */
export function encodeAgentClientMessageHeartbeat(): Uint8Array {
  return encMsg(7, new Uint8Array(0))
}
