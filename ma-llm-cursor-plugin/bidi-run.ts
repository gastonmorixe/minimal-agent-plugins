/**
 * Bidirectional AgentService/Run orchestration (tool loop on one h2 stream).
 *
 * Uses the host NetworkClient with `keepRequestOpen` so net-dbg, activity
 * observers, and Http2Transport session pooling all apply.
 *
 * @module llm/providers/cursor/bidi-run
 */

import { cursorBidiLog } from "./bidi-debug.ts"
import {
  extractTrailingFollowUpUserText,
  extractTrailingToolResults,
  requestHasToolResultContinuation,
  toolResultToWireText,
} from "./bidi-tool-results.ts"
import { openCursorBidiWire } from "./connect/bidi-wire.ts"
import {
  type CursorBidiSession,
  clearCursorBidiSession,
  getCursorBidiSession,
  setCursorBidiSession,
} from "./cursor-bidi-session.ts"
import { cursorToolsEnabledOnWire } from "./cursor-tool-policy.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { NetworkClient } from "./lib/net-types.ts"
import type { ModelView } from "./lib/provider-plugin.ts"
import {
  encodeAgentClientMessageConversationAction,
  extractServerTextEvents,
} from "./proto/agent-run.ts"
import {
  encodeAgentClientMessageExecResult,
  encodeAgentClientMessageExecStreamClose,
  encodeShellStreamExecFrames,
} from "./proto/client-message.ts"
import { decodeAgentServerMessage } from "./proto/exec-server-decode.ts"
import { decodeKvServerMessage, encodeAgentClientMessageKvReply } from "./proto/kv.ts"
import { resolveCursorWireAgentMode } from "./request-body.ts"
import { CursorBidiEnvelopeTranslator } from "./response-stream-bidi.ts"

export type CursorBidiRunOpts = {
  url: string
  headers: Record<string, string>
  initialRunBody: Uint8Array
  signal?: AbortSignal
  sessionId: string
  modelId: string
  networkClient: NetworkClient
}

/** Whether this request should use the bidi tool loop (vs unary NetworkClient). */
export function shouldUseCursorBidi(req: CanonicalRequest, networkClient?: unknown): boolean {
  if (process.env.MA_CURSOR_BIDI === "0") return false
  if (!networkClient) return false
  return cursorToolsEnabledOnWire(req)
}

/**
 * Run Cursor AgentService/Run with bidi tool-result write when tools are enabled.
 */
export async function* runCursorBidi(
  req: CanonicalRequest,
  _model: ModelView,
  opts: CursorBidiRunOpts,
): AsyncGenerator<CanonicalEvent> {
  const sessionKey = opts.sessionId || "default"
  const existing = getCursorBidiSession(sessionKey)

  if (existing && requestHasToolResultContinuation(req)) {
    if (existing.pendingExec && !existing.wire.isClosed()) {
      cursorBidiLog("run.continue", { sessionKey })
      try {
        yield* continueBidiSession(req, existing, opts)
        return
      } catch (err) {
        // A terminal event can race this check. Do not leave a dead session
        // with pendingExec in the map, where every later continuation retries
        // the same closed wire until the process is restarted.
        clearCursorBidiSession(sessionKey, existing)
        throw err
      }
    }
    cursorBidiLog("run.continue-fresh-wire", {
      sessionKey,
      reason: existing.pendingExec ? "wire-closed" : "no-pending-exec",
    })
    clearCursorBidiSession(sessionKey, existing)
  } else if (existing) {
    clearCursorBidiSession(sessionKey)
  }

  cursorBidiLog("run.open", { sessionKey })
  const wire = await openCursorBidiWire({
    url: opts.url,
    headers: opts.headers,
    initialRunBody: opts.initialRunBody,
    signal: opts.signal,
    networkClient: opts.networkClient,
  })

  const conversationId = crypto.randomUUID()
  const envelopeGen = wire.envelopes(opts.signal)
  const translator = new CursorBidiEnvelopeTranslator({ modelId: opts.modelId })
  const session: CursorBidiSession = {
    wire,
    envelopeGen,
    translator,
    conversationId,
    pendingExec: null,
    blobStore: new Map(),
  }
  setCursorBidiSession(sessionKey, session)

  try {
    yield* readBidiUntilPauseOrEnd(session, opts)
  } catch (err) {
    clearCursorBidiSession(sessionKey)
    throw err
  }
}

async function* continueBidiSession(
  req: CanonicalRequest,
  session: CursorBidiSession,
  opts: CursorBidiRunOpts,
): AsyncGenerator<CanonicalEvent> {
  const pending = session.pendingExec
  if (!pending) {
    cursorBidiLog("continue.no-pending-exec", { sessionId: opts.sessionId })
    clearCursorBidiSession(opts.sessionId)
    yield {
      type: "stream_error",
      retryable: false,
      category: "api",
      cause: new Error("cursor bidi: tool results received but no pending exec"),
    }
    return
  }

  const results = extractTrailingToolResults(req.messages)
  const match =
    results.find((r) => r.toolUseId === pending.toolCallId) ?? results[results.length - 1]
  cursorBidiLog("continue.pending", {
    execId: pending.execId,
    execNumericId: pending.id,
    toolCallId: pending.toolCallId,
    toolName: pending.toolName,
    matchedToolUseId: match?.toolUseId,
  })
  if (!match) {
    clearCursorBidiSession(opts.sessionId)
    yield {
      type: "stream_error",
      retryable: false,
      category: "api",
      cause: new Error("cursor bidi: no matching tool_result for pending exec"),
    }
    return
  }

  const resultText = toolResultToWireText(match)
  const resultOpts = {
    id: pending.id,
    // Cursor's own client only sets ExecClientMessage.id + result oneof
    // (not exec_id field 15). Sending exec_id can break correlation.
    execId: "",
    resultText,
    isError: Boolean(match.isError),
    nativeExecFieldNo: pending.nativeExecFieldNo,
  }
  // shell_stream_args → multiple ShellStream events; everything else → one result.
  const payloads =
    pending.nativeExecFieldNo === 14
      ? encodeShellStreamExecFrames(resultOpts)
      : [encodeAgentClientMessageExecResult(resultOpts)]
  const streamClose = encodeAgentClientMessageExecStreamClose(pending.id)
  cursorBidiLog("continue.write-mcp-result", {
    frameCount: payloads.length,
    nativeExecFieldNo: pending.nativeExecFieldNo ?? null,
    mcpResultBytes: payloads.reduce((n, p) => n + p.length, 0),
    streamCloseBytes: streamClose.length,
    resultPreview: resultText.slice(0, 120),
  })

  // Host drained a mid-turn user prompt into this continuation (tool_results +
  // text). Official CLI writes AgentClientMessage.conversation_action on the
  // live stream (`queued_action`) via conversationActionManager, independent of
  // exec stream_close. Write the follow-up BEFORE closing the exec so Cursor
  // can preempt the in-flight turn instead of hanging after mcp_result.
  const followUpText = extractTrailingFollowUpUserText(req.messages)
  if (followUpText) {
    const conversationAction = encodeAgentClientMessageConversationAction({
      text: followUpText,
      modelId: opts.modelId,
      conversationId: session.conversationId,
      mode: resolveCursorWireAgentMode(req),
    })
    cursorBidiLog("continue.write-conversation-action", {
      bytes: conversationAction.length,
      preview: followUpText.slice(0, 120),
    })
    session.wire.writeProto(conversationAction)
  }

  for (const payload of payloads) session.wire.writeProto(payload)
  session.wire.writeProto(streamClose)
  session.pendingExec = null
  session.translator.clearAfterMcpReply()

  cursorBidiLog("continue.read-after-mcp")
  yield* readBidiUntilPauseOrEnd(session, opts)
}

async function* readBidiUntilPauseOrEnd(
  session: CursorBidiSession,
  opts: CursorBidiRunOpts,
): AsyncGenerator<CanonicalEvent> {
  const sessionKey = opts.sessionId || "default"

  // envelopeGen is created once at open with attempt-1's AbortSignal. Each
  // continue is a new host attempt (new withStreamWatchdog AbortController).
  // Re-bind the *current* signal so TTFB/idle abort can close the keep-open
  // wire; otherwise a silent post-mcp read hangs forever (Heather 3c7e375a).
  const onAbort = () => {
    try {
      session.wire.close()
    } catch {
      /* ignore */
    }
  }
  if (opts.signal?.aborted) {
    onAbort()
    throw opts.signal.reason instanceof Error
      ? opts.signal.reason
      : new Error("cursor bidi: aborted")
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    while (true) {
      const next = await session.envelopeGen.next()
      cursorBidiLog("read.envelope-next", {
        done: next.done,
        payloadBytes: next.done ? 0 : next.value.payload.length,
        endStream: next.done ? false : next.value.endStream,
      })
      if (next.done) {
        cursorBidiLog("read.envelope-done")
        for (const event of session.translator.finishIfStarted()) {
          cursorBidiLog("read.event", { type: event.type })
          yield event
        }
        if (!session.pendingExec) clearCursorBidiSession(sessionKey)
        return
      }

      const kv = decodeKvServerMessage(next.value.payload)
      if (kv) {
        cursorBidiLog("read.kv", {
          kind: kv.kind,
          id: kv.id,
          blobBytes: kv.kind === "set" ? kv.blobData.byteLength : 0,
        })
        session.wire.writeProto(encodeAgentClientMessageKvReply(kv, session.blobStore))
        continue
      }

      const { events, streamEnded, pauseForToolUse } = session.translator.push(next.value)
      cursorBidiLog("read.translated", {
        eventCount: events.length,
        streamEnded,
        pauseForToolUse,
        eventTypes: events.map((e) => e.type).join(","),
      })
      let sawStreamError = false
      let sawToolUseDelta = false
      for (const event of events) {
        cursorBidiLog("read.event", { type: event.type })
        if (event.type === "stream_error") {
          sawStreamError = true
          yield event
          continue
        }
        yield event
        if (event.type === "message_delta" && event.stopReason === "tool_use") {
          sawToolUseDelta = true
          session.pendingExec = session.translator.getPendingExec() ?? null
          if (!session.pendingExec) {
            cursorBidiLog("read.skip-tool-pause-no-exec")
            sawToolUseDelta = false
            continue
          }
        }
        if (event.type === "message_stop") {
          if (sawToolUseDelta && session.pendingExec) {
            // Tool-use pause: keep session alive for continuation.
            cursorBidiLog("read.pause-tool-use", {
              hasPendingExec: true,
              toolName: session.pendingExec.toolName,
            })
            return
          }
          clearCursorBidiSession(sessionKey)
          return
        }
      }
      if (sawStreamError) {
        clearCursorBidiSession(sessionKey)
        return
      }

      if (pauseForToolUse) {
        session.pendingExec = session.translator.getPendingExec() ?? null
        if (!session.pendingExec) {
          cursorBidiLog("read.skip-tool-pause-no-exec")
          continue
        }
        cursorBidiLog("read.pause-tool-use", { hasPendingExec: true })
        return
      }

      if (streamEnded) {
        clearCursorBidiSession(sessionKey)
        return
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort)
  }
}

/** Decode one Connect payload into server events (shared with tests). */
export function decodeConnectPayloadEvents(payload: Uint8Array) {
  const msg = decodeAgentServerMessage(payload)
  if (msg.kind === "exec_server_mcp") {
    return { execMcp: msg.execMcp }
  }
  if (msg.kind === "interaction_update" && msg.interactionBody) {
    return { interaction: extractServerTextEvents(payload) }
  }
  return {}
}
