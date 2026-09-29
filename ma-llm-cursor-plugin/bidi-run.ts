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
import { buildCursorToolWirePolicy, cursorToolsEnabledOnWire } from "./cursor-tool-policy.ts"
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
  encodeAgentClientMessageExecThrow,
  encodeShellStreamExecFrames,
} from "./proto/client-message.ts"
import {
  decodeAgentServerMcpState,
  encodeAgentClientMcpStateResult,
} from "./proto/exec-mcp-state.ts"
import {
  decodeAgentServerExecId,
  decodeAgentServerMessage,
  findUnsupportedExec,
} from "./proto/exec-server-decode.ts"
import { decodeInteractionQuery, encodeInteractionRejection } from "./proto/interaction-query.ts"
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

/**
 * Whether this request should use the bidi wire (vs unary NetworkClient).
 *
 * Tool-less requests (context compaction, titles, summaries) need bidi too: the
 * server sends KvServerMessage set_blob and waits for the ack before
 * turn_ended, and only the bidi wire can answer. On the unary path those turns
 * hung until the host watchdog (live, 2026-09-28).
 */
export function shouldUseCursorBidi(_req: CanonicalRequest, networkClient?: unknown): boolean {
  if (process.env.MA_CURSOR_BIDI === "0") return false
  return Boolean(networkClient)
}

/**
 * Write a read-loop ack (KV, interaction, mcp_state, exec throw). When the server
 * already closed its side, nothing waits for the ack, so skip it instead of
 * failing the turn on the envelopes still queued.
 */
function writeAck(session: CursorBidiSession, payload: Uint8Array): void {
  if (session.wire.isClosed()) {
    cursorBidiLog("read.ack-skipped-closed", { protoBytes: payload.length })
    return
  }
  session.wire.writeProto(payload)
}

/**
 * Session key for a Run. Tool-less side calls (compaction, titles, summaries)
 * never pend an exec or continue, so each one gets a unique key: it never
 * closes an open tool session, or another tool-less run, on the same host id.
 */
function bidiSessionKeyFor(req: CanonicalRequest, sessionId: string): string {
  const base = sessionId || "default"
  return cursorToolsEnabledOnWire(req) ? base : `${base}:notools:${crypto.randomUUID()}`
}

/**
 * Run Cursor AgentService/Run with bidi tool-result write when tools are enabled.
 */
export async function* runCursorBidi(
  req: CanonicalRequest,
  _model: ModelView,
  runOpts: CursorBidiRunOpts,
): AsyncGenerator<CanonicalEvent> {
  // Every later use (continue, read loop, clear) keys on opts.sessionId.
  const opts = { ...runOpts, sessionId: bidiSessionKeyFor(req, runOpts.sessionId) }
  const sessionKey = opts.sessionId
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
    mcpTools: buildCursorToolWirePolicy(req).mcpTools,
  }
  setCursorBidiSession(sessionKey, session)

  try {
    yield* readBidiUntilPauseOrEnd(session, opts)
  } finally {
    // Runs on normal end, throw, and early return (the caller stops iterating:
    // Esc, a watchdog, a host retry). Only a tool pause with a pending exec
    // keeps the session, for the continuation. Anything else would leak an
    // open wire: tool-less keys are unique and never overwritten.
    if (!session.pendingExec) clearCursorBidiSession(sessionKey, session)
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
  yield* readBidiUntilPauseOrEnd(session, opts, cursorBidiContinueIdleMs())
}

/** Server heartbeat frames are 4 bytes. Anything larger counts as progress. */
const CURSOR_BIDI_HEARTBEAT_MAX_BYTES = 4

/** Default no-progress limit after a tool result is written on the open stream. */
const CURSOR_BIDI_CONTINUE_IDLE_DEFAULT_MS = 30_000

/**
 * How long a continuation may see no real server frame before we give up.
 * `MA_CURSOR_BIDI_CONTINUE_IDLE_MS=0` disables the guard.
 */
export function cursorBidiContinueIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MA_CURSOR_BIDI_CONTINUE_IDLE_MS?.trim()
  if (raw === undefined || raw === "") return CURSOR_BIDI_CONTINUE_IDLE_DEFAULT_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return CURSOR_BIDI_CONTINUE_IDLE_DEFAULT_MS
  return n
}

const IDLE_TIMEOUT = Symbol("cursor-bidi-idle-timeout")

/**
 * Wait for `pending`, or give up once `remainingMs` passes.
 * The timer is cleared as soon as `pending` settles.
 */
async function raceIdle<T>(
  pending: Promise<T>,
  remainingMs: number,
): Promise<T | typeof IDLE_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const idle = new Promise<typeof IDLE_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(IDLE_TIMEOUT), Math.max(0, remainingMs))
  })
  try {
    return await Promise.race([pending, idle])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Read server frames until the turn ends or pauses for a tool call.
 *
 * The optional third argument is the idle guard in ms. When above 0, give up
 * after that long without a real (non-heartbeat) frame. Continuations use it:
 * after a tool result is written on the open stream there is no new HTTP
 * request, so the host watchdog stays in "pre-headers" for its full 120 s.
 */
async function* readBidiUntilPauseOrEnd(
  session: CursorBidiSession,
  opts: CursorBidiRunOpts,
  idleGuardMs = 0,
): AsyncGenerator<CanonicalEvent> {
  let lastProgressAt = Date.now()
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
      const pending = session.envelopeGen.next()
      const raced =
        idleGuardMs > 0
          ? await raceIdle(pending, idleGuardMs - (Date.now() - lastProgressAt))
          : await pending
      if (raced === IDLE_TIMEOUT) {
        cursorBidiLog("continue.idle-timeout", {
          idleGuardMs,
          silentMs: Date.now() - lastProgressAt,
        })
        onAbort()
        clearCursorBidiSession(sessionKey, session)
        // The abandoned next() settles once the wire closes. Ignore its outcome.
        pending.catch(() => {})
        yield {
          type: "stream_error",
          retryable: true,
          category: "timeout",
          // Must be a tag core's retry classifier knows ("stream_idle"), or the
          // host would surface this error instead of retrying with a fresh Run.
          upstreamType: "stream_idle",
          cause: new Error(
            `cursor bidi: no progress for ${Math.round(idleGuardMs / 1000)}s after the tool result was sent`,
          ),
        }
        return
      }
      const next = raced
      if (!next.done && next.value.payload.length > CURSOR_BIDI_HEARTBEAT_MAX_BYTES) {
        lastProgressAt = Date.now()
      }
      cursorBidiLog("read.envelope-next", {
        done: next.done,
        payloadBytes: next.done ? 0 : next.value.payload.length,
        endStream: next.done ? false : next.value.endStream,
      })
      if (next.done) {
        cursorBidiLog("read.envelope-done")
        // finishOnClose: zero-content stream is an error (usage cap), not silence.
        for (const event of session.translator.finishOnClose()) {
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
        writeAck(session, encodeAgentClientMessageKvReply(kv, session.blobStore))
        continue
      }

      // interaction_query (#7): the server waits for interaction_response (#6).
      // MA has no approval UI for Cursor-native flows, so reject instead of hanging.
      const query = decodeInteractionQuery(next.value.payload)
      if (query) {
        cursorBidiLog("read.interaction-query", { id: query.id, queryField: query.queryField })
        writeAck(session, encodeInteractionRejection(query))
        continue
      }

      // mcp_state_exec_args (exec #36): the server asks which MCP servers and
      // tools the client has before it exposes them to the model. Unanswered,
      // the turn hangs and the model never sees MA tools.
      const mcpState = decodeAgentServerMcpState(next.value.payload)
      if (mcpState) {
        cursorBidiLog("read.mcp-state", {
          id: mcpState.id,
          servers: mcpState.serverIdentifiers.join(","),
          kickOnly: mcpState.kickOnly,
          toolCount: session.mcpTools?.length ?? 0,
        })
        writeAck(
          session,
          encodeAgentClientMcpStateResult(
            mcpState,
            session.mcpTools ?? [],
            mcpState.serverIdentifiers,
          ),
        )
        writeAck(session, encodeAgentClientMessageExecStreamClose(mcpState.id))
        continue
      }

      // Any other exec MA cannot answer: reply like the official CLI does with
      // no handler (throw, then stream_close). Unanswered, the server waits
      // forever and heartbeats keep the stream open.
      const unsupported = findUnsupportedExec(next.value.payload)
      if (unsupported) {
        const execId = decodeAgentServerExecId(next.value.payload)
        cursorBidiLog("read.exec-unsupported", {
          id: execId,
          fieldNo: unsupported.fieldNo,
          name: unsupported.name,
        })
        writeAck(
          session,
          encodeAgentClientMessageExecThrow(
            execId,
            `minimal-agent has no handler for server exec ${unsupported.name}`,
          ),
        )
        writeAck(session, encodeAgentClientMessageExecStreamClose(execId))
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
