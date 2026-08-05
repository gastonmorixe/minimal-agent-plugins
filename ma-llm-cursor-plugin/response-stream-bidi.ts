/**
 * Connect envelope → CanonicalEvent for bidi AgentService/Run.
 *
 * Handles interaction_update (text/thinking/tools UI) and exec_server_message
 * (authoritative MCP execution requests).
 *
 * @module llm/providers/cursor/response-stream-bidi
 */

import { cursorBidiLog } from "./bidi-debug.ts"
import type { ConnectEnvelope } from "./connect/stream.ts"
import {
  applyCursorUsageEvent,
  type CursorUsageState,
  cursorUsageReceipts,
  cursorUsageToCanonical,
} from "./cursor-usage.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import { extractServerTextEvents, parseConnectEndStreamError } from "./proto/agent-run.ts"
import {
  type DecodedExecMcpArgs,
  decodeAgentServerExec,
  decodeAgentServerMessage,
} from "./proto/exec-server-decode.ts"
import type { DecodedCursorMcpToolCall } from "./proto/tool-call-decode.ts"

export type TranslateCursorBidiOpts = {
  modelId: string
  messageId?: string
  onExecMcp?: (exec: DecodedExecMcpArgs) => void
}

export type BidiTranslatorPush = {
  events: CanonicalEvent[]
  /** Stream finished (turn ended or end-stream frame). */
  streamEnded: boolean
  /** Pause after tool_use; caller writes mcp_result on same h2 stream when pendingExec is set. */
  pauseForToolUse: boolean
}

// Core requires tool_use id/name to match /^[a-zA-Z0-9_-]{1,64}$/.
const TOOL_USE_TOKEN_RE = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Normalize a Cursor toolCallId/name for MA's adapter-legacy regex.
 * Cursor sometimes packs two ids separated by a newline; keep the first
 * valid segment rather than mangling both into a truncated mash.
 */
function sanitizeToolUseToken(raw: string | undefined, fallbackPrefix: string): string {
  const candidates = (raw ?? "")
    .split(/[\r\n\u0000]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const c of candidates) {
    if (TOOL_USE_TOKEN_RE.test(c)) return c
    const cleaned = c
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 64)
    if (TOOL_USE_TOKEN_RE.test(cleaned)) return cleaned
  }
  return `${fallbackPrefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

/**
 * Stateful translator for one bidi wire session.
 *
 * Use `push()` from a single manual `envelopeGen.next()` loop so pausing for
 * tool_use does not close the shared async iterator (unlike nested for-await).
 */
export class CursorBidiEnvelopeTranslator {
  private readonly messageId: string
  private readonly usageState: CursorUsageState = {}
  private started = false
  private textOpen = false
  private thinkingOpen = false
  private textIndex = 0
  private thinkingIndex = 0
  private blockIndex = 0
  private sawToolUse = false
  private pendingExec: DecodedExecMcpArgs | undefined
  private pendingToolIndex: number | undefined
  private pendingToolId: string | undefined
  private pendingToolName: string | undefined
  private pendingToolInput: Record<string, unknown> | undefined
  private emittedExecToolCallIds = new Set<string>()

  constructor(private readonly opts: TranslateCursorBidiOpts) {
    this.messageId = opts.messageId ?? crypto.randomUUID()
  }

  /** Clear exec/tool pause state after mcp_result is written on the wire. */
  clearAfterMcpReply(): void {
    this.pendingExec = undefined
    this.pendingToolIndex = undefined
    this.pendingToolId = undefined
    this.pendingToolName = undefined
    this.pendingToolInput = undefined
    this.sawToolUse = false
  }

  /** Last exec_server_message args (set before pause when server awaits mcp_result). */
  getPendingExec(): DecodedExecMcpArgs | undefined {
    return this.pendingExec
  }

  /** Translate one Connect envelope; may request pause after tool_use. */
  push(frame: ConnectEnvelope): BidiTranslatorPush {
    if (frame.endStream) {
      const events: CanonicalEvent[] = []
      const parsed = parseConnectEndStreamError(frame.payload)
      if (parsed) {
        const cause = new Error(parsed.message)
        events.push({
          type: "stream_error",
          retryable: false,
          category: "api",
          upstreamType: (parsed.code ?? "connect_end_stream").slice(0, 200),
          cause,
        })
      }
      events.push(...this.finish(this.sawToolUse ? "tool_use" : "end_turn"))
      return { events, streamEnded: true, pauseForToolUse: false }
    }

    if (frame.payload.length === 0) {
      return { events: [], streamEnded: false, pauseForToolUse: false }
    }

    const decoded = decodeAgentServerMessage(frame.payload)
    cursorBidiLog("translate.frame", {
      payloadBytes: frame.payload.length,
      kind: decoded.kind,
      endStream: frame.endStream,
    })

    const execFromField2 = decodeAgentServerExec(frame.payload)
    if (execFromField2) {
      const events = this.emitExecMcpToolUse(execFromField2)
      if (events.length > 0) {
        this.pendingExec = execFromField2
        this.opts.onExecMcp?.(execFromField2)
        return { events, streamEnded: false, pauseForToolUse: true }
      }
      return { events: [], streamEnded: false, pauseForToolUse: false }
    }

    const { events, turnEnded, pauseForToolUse } = this.handleServerPayload(frame.payload)
    if (turnEnded) {
      return { events, streamEnded: true, pauseForToolUse: this.sawToolUse }
    }
    return { events, streamEnded: false, pauseForToolUse }
  }

  /** Emit terminal events when the envelope stream ends without turn_ended. */
  finishIfStarted(): CanonicalEvent[] {
    if (!this.started) return []
    return this.finish(this.sawToolUse ? "tool_use" : "end_turn")
  }

  private openMessage(): CanonicalEvent[] {
    if (this.started) return []
    this.started = true
    return [
      {
        type: "message_start",
        messageId: this.messageId,
        modelId: this.opts.modelId,
        initialUsage: cursorUsageToCanonical(this.usageState),
      },
    ]
  }

  private closeText(): CanonicalEvent[] {
    if (!this.textOpen) return []
    this.textOpen = false
    return [{ type: "text_stop", index: this.textIndex }]
  }

  private closeThinking(): CanonicalEvent[] {
    if (!this.thinkingOpen) return []
    this.thinkingOpen = false
    return [{ type: "thinking_stop", index: this.thinkingIndex }]
  }

  private emitToolUseStop(): CanonicalEvent[] {
    if (this.pendingToolIndex === undefined || !this.pendingToolId || !this.pendingToolName) {
      return []
    }
    const input = this.pendingToolInput ?? {}
    const out: CanonicalEvent[] = [
      {
        type: "tool_use_input_delta",
        index: this.pendingToolIndex,
        partialJson: JSON.stringify(input),
      },
      {
        type: "tool_use_stop",
        index: this.pendingToolIndex,
        input,
      },
    ]
    this.pendingToolIndex = undefined
    this.pendingToolId = undefined
    this.pendingToolName = undefined
    this.pendingToolInput = undefined
    return out
  }

  private finish(stopReason: "end_turn" | "tool_use"): CanonicalEvent[] {
    const receipts = cursorUsageReceipts(this.usageState)
    return [
      ...this.closeText(),
      ...this.closeThinking(),
      ...this.emitToolUseStop(),
      ...this.openMessage(),
      {
        type: "message_delta",
        stopReason,
        usage: cursorUsageToCanonical(this.usageState),
        ...(receipts ? { receipts } : {}),
      },
      { type: "message_stop" },
    ]
  }

  private emitExecMcpToolUse(exec: DecodedExecMcpArgs): CanonicalEvent[] {
    const rawName = exec.maToolName ?? exec.toolName
    if (!rawName) return []
    const rawId = exec.toolCallId
    // Core adapter-legacy rejects ids/names outside [a-zA-Z0-9_-]{1,64}.
    const id = sanitizeToolUseToken(rawId, "tool")
    const name = sanitizeToolUseToken(rawName, "Tool")
    exec.toolCallId = id
    exec.maToolName = name
    if (this.emittedExecToolCallIds.has(id)) {
      cursorBidiLog("translate.skip-dup-exec-tool", { toolCallId: id })
      return []
    }
    this.emittedExecToolCallIds.add(id)
    cursorBidiLog("emit-exec-tool-use", {
      toolName: name,
      toolCallId: id,
      rawToolCallId: rawId,
      sanitized: id !== rawId || name !== rawName,
      hasInput: exec.input != null,
      inputKeys: exec.input ? Object.keys(exec.input) : [],
      inputPreview: exec.input ? JSON.stringify(exec.input).slice(0, 200) : "(none)",
    })
    const idx = this.blockIndex++
    this.sawToolUse = true
    return [
      ...this.openMessage(),
      ...this.closeText(),
      ...this.closeThinking(),
      { type: "tool_use_start", index: idx, id, name },
      {
        type: "tool_use_input_delta",
        index: idx,
        partialJson: JSON.stringify(exec.input ?? {}),
      },
      { type: "tool_use_stop", index: idx, input: exec.input ?? {} },
      ...this.finish("tool_use"),
    ]
  }

  private handleMcpToolCall(
    call: DecodedCursorMcpToolCall | undefined,
    phase: "started" | "completed",
  ): { events: CanonicalEvent[]; pause: boolean } {
    if (!call) return { events: [], pause: false }
    if (call.builtinOneof && call.builtinOneof !== "mcpToolCall") {
      cursorBidiLog("translate.skip-native-tool", { builtin: call.builtinOneof })
      return { events: [], pause: false }
    }
    // Bidi: only exec_server_message (field 2) drives tool execution.
    // interaction_update tool_call_* frames are UI-only duplicates.
    cursorBidiLog("translate.skip-interaction-tool", { phase, tool: call.toolName })
    return { events: [], pause: false }
  }

  private handleServerPayload(payload: Uint8Array): {
    events: CanonicalEvent[]
    turnEnded: boolean
    pauseForToolUse: boolean
  } {
    const events: CanonicalEvent[] = []
    let pauseForToolUse = false
    for (const ev of extractServerTextEvents(payload)) {
      applyCursorUsageEvent(this.usageState, ev)
      if (
        ev.kind === "heartbeat" ||
        ev.kind === "token_delta" ||
        ev.kind === "conversation_checkpoint_update" ||
        ev.kind === "summary" ||
        ev.kind === "summary_started" ||
        ev.kind === "summary_completed" ||
        ev.kind === "interaction_query"
      ) {
        continue
      }
      if (ev.kind === "tool_call_started") {
        const tool = this.handleMcpToolCall(ev.toolCall, "started")
        events.push(...tool.events)
        if (tool.pause) pauseForToolUse = true
        continue
      }
      if (ev.kind === "tool_call_completed") {
        const tool = this.handleMcpToolCall(ev.toolCall, "completed")
        events.push(...tool.events)
        if (tool.pause) pauseForToolUse = true
        continue
      }
      if (ev.kind === "text_delta" && ev.text) {
        events.push(...this.openMessage())
        events.push(...this.closeThinking())
        if (!this.textOpen) {
          this.textIndex = this.blockIndex++
          this.textOpen = true
          events.push({ type: "text_start", index: this.textIndex })
        }
        events.push({ type: "text_delta", index: this.textIndex, text: ev.text })
      } else if (ev.kind === "thinking_delta" && ev.text) {
        events.push(...this.openMessage())
        events.push(...this.closeText())
        if (!this.thinkingOpen) {
          this.thinkingIndex = this.blockIndex++
          this.thinkingOpen = true
          events.push({ type: "thinking_start", index: this.thinkingIndex })
        }
        events.push({ type: "thinking_delta", index: this.thinkingIndex, text: ev.text })
      } else if (ev.kind === "turn_ended") {
        events.push(...this.finish(this.sawToolUse ? "tool_use" : "end_turn"))
        return { events, turnEnded: true, pauseForToolUse: this.sawToolUse }
      }
    }
    return { events, turnEnded: false, pauseForToolUse }
  }
}

/**
 * Translate bidi Connect envelopes into canonical events (one-shot async iterable).
 * Prefer {@link CursorBidiEnvelopeTranslator} when resuming the same wire across runs.
 */
export async function* translateCursorBidiEnvelopes(
  envelopes: AsyncIterable<ConnectEnvelope>,
  opts: TranslateCursorBidiOpts,
): AsyncGenerator<CanonicalEvent> {
  const translator = new CursorBidiEnvelopeTranslator(opts)
  for await (const frame of envelopes) {
    const { events, streamEnded, pauseForToolUse } = translator.push(frame)
    for (const event of events) yield event
    if (pauseForToolUse || streamEnded) return
  }
  for (const event of translator.finishIfStarted()) yield event
}
