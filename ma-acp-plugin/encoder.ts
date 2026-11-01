/**
 * The ACP `session/update` encoder: core {@link AgentEvent} → ACP updates,
 * through core's shared wire mapper (`@minimal-agent/core/sdk/events`).
 * ACP field names live here, never in core (spec v3 section 5).
 *
 * One encoder per session. It keeps the per-turn facts the stop reason
 * needs (last `turn_completed.stopReason`, last stop-relevant notice, last
 * error) and resets them at {@link SessionEncoder.finishTurn}.
 *
 * Mapping (spec v3 section 6, design doc sections 6 and 7):
 * - `text_delta` / `thinking_delta` → `agent_message_chunk` / `agent_thought_chunk`.
 * - `tool_call` → `tool_call` with `kind` from {@link toolKindOf} (`run` →
 *   `execute`), `status` from {@link toolStatusOf} (`pending`), a title,
 *   `rawInput`, and `locations` for file tools.
 * - `status` phase `running_tool` → `tool_call_update` `in_progress` for one
 *   open tool call (core emits it right after `tool_call`, before the tool
 *   runs; the encoder tracks "running" itself, as the mapper doc says). The
 *   encoder tracks every open tool call. It marks the oldest open call with
 *   the same tool name that is not yet running, else the oldest one that is
 *   not yet running. Each call gets `in_progress` once.
 * - `tool_output` → `tool_call_update` with the (capped) text as content.
 * - `tool_result` → `tool_call_update` `completed` or `failed`.
 * - `turn_completed` → `usage_update`: `used` = that turn's input + cache
 *   read + cache creation tokens (a PROXY for the context size, never a
 *   sum over turns), `size` = the model's `contextWindow`. No cost.
 * - `notice` → ACP notice (see `notices.ts`). `model_adopted` also pushes
 *   `config_option_update` with the complete option list, every time.
 *   `model_adopt_failed` pushes no `config_option_update`, because the
 *   model did not change.
 *
 * @module encoder
 */

import { isAbsolute, resolve } from "node:path"

import type { AgentEvent, WireToolCategory, WireToolStatus } from "@minimal-agent/core/sdk/events"
import {
  toolKindOf,
  toolStatusOf,
  toWireMessageDelta,
  toWireToolFinished,
  toWireToolProgress,
  toWireToolStarted,
  toWireUsage,
} from "@minimal-agent/core/sdk/events"
import type { TurnNotice } from "@minimal-agent/core/sdk/turn-notice"

import { buildConfigOptions, type ConfigRuntime } from "./config-options.ts"
import { type AcpNotice, noticeUpdate, toAcpNotice } from "./notices.ts"
import {
  decideStopReason,
  type ProviderStopReason,
  type StopDecision,
  type StopInputs,
} from "./stop-reason.ts"

/** ACP `ToolKind`. */
export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other"

/** ACP `ToolCallStatus`. */
export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed"

/** Neutral tool category → ACP tool kind. Only `run` changes name. */
export function toAcpToolKind(category: WireToolCategory): AcpToolKind {
  return category === "run" ? "execute" : category
}

/** Neutral tool status → ACP tool status. A denial is `failed` (ACP has no denied status). */
export function toAcpToolStatus(status: WireToolStatus): AcpToolStatus {
  switch (status) {
    case "pending":
      return "pending"
    case "running":
      return "in_progress"
    case "succeeded":
      return "completed"
    case "failed":
    case "denied":
      return "failed"
    default: {
      const _exhaustive: never = status
      throw new Error(`unknown tool status: ${String(_exhaustive)}`)
    }
  }
}

/** ACP `ToolCallLocation`. */
export interface AcpToolLocation {
  readonly path: string
  readonly line?: number
}

/**
 * File locations for the built-in file tools (design doc section 6):
 * Read/Write/Edit `file_path` (Read adds `line` from `offset`), Glob/Grep
 * `path` (alias `target_directory`). Relative paths resolve against `cwd`
 * (ACP paths are absolute).
 */
export function toolLocations(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): AcpToolLocation[] {
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(cwd, p))
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined)
  switch (toolName) {
    case "Read": {
      const path = str(input.file_path)
      if (!path) return []
      const offset = input.offset
      return typeof offset === "number" && Number.isInteger(offset) && offset >= 0
        ? [{ path: abs(path), line: offset }]
        : [{ path: abs(path) }]
    }
    case "Write":
    case "Edit": {
      const path = str(input.file_path)
      return path ? [{ path: abs(path) }] : []
    }
    case "Glob":
    case "Grep": {
      const path = str(input.path) ?? str(input.target_directory)
      return path ? [{ path: abs(path) }] : []
    }
    default:
      return []
  }
}

/** What a session encoder needs from its host. */
export interface SessionEncoderOptions {
  /** Sends one `session/update` `update` object. */
  readonly send: (update: Record<string, unknown>) => void
  /** True when the client advertised `clientCapabilities.session.notices`. */
  readonly clientNotices: boolean
  /** Live model and effort state, for `config_option_update` and `usage_update.size`. */
  readonly runtime: ConfigRuntime
  /** Process cwd, to make tool locations absolute. */
  readonly cwd: string
}

/** The prompt reply the host sends, or a JSON-RPC error to raise instead. */
export type TurnReply =
  | { readonly kind: "reply"; readonly result: Record<string, unknown> }
  | { readonly kind: "error"; readonly code: number; readonly message: string }

/** A per-session encoder. */
export interface SessionEncoder {
  /** Encode one core event and send its updates. */
  encode(event: AgentEvent): void
  /** Decide the stop reason, send any notice that goes before the reply, and reset turn state. */
  finishTurn(outcome: StopInputs["outcome"]): TurnReply
  /** Push the complete config option list (`config_option_update`). */
  pushConfigOptions(): void
  /**
   * Resolves when the `tool_call` update for `toolCallId` is sent (at once
   * if it is sent already), or after `timeoutMs`. Never rejects.
   */
  toolCallSent(toolCallId: string, timeoutMs: number): Promise<void>
}

/** Notice kinds that change the stop reason (see `deriveStopCause`). */
const STOP_NOTICE_KINDS: ReadonlySet<TurnNotice["kind"]> = new Set([
  "refusal",
  "content_filter",
  "max_tokens_capped",
  "stream_interrupted_capped",
])

/** Create the encoder for one ACP session. */
export function createSessionEncoder(options: SessionEncoderOptions): SessionEncoder {
  const { send, clientNotices, runtime, cwd } = options
  let noticeSeq = 0
  let lastStopReason: ProviderStopReason | undefined
  let lastNotice: TurnNotice | null = null
  let lastError: { message: string; code?: string } | null = null
  // Open tool calls in start order: id → tool name and "running" state.
  const openToolCalls = new Map<string, { readonly toolName: string; running: boolean }>()
  // Callers of `toolCallSent` that wait for a `tool_call` update, by id.
  const toolCallWaiters = new Map<string, Array<() => void>>()
  const toolCallSent = (toolCallId: string, timeoutMs: number): Promise<void> => {
    if (openToolCalls.has(toolCallId)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        const list = toolCallWaiters.get(toolCallId)
        const rest = list?.filter((w) => w !== done) ?? []
        if (rest.length > 0) toolCallWaiters.set(toolCallId, rest)
        else toolCallWaiters.delete(toolCallId)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      toolCallWaiters.set(toolCallId, [...(toolCallWaiters.get(toolCallId) ?? []), done])
    })
  }
  const nextToRun = (toolName: string | undefined): string | undefined => {
    let fallback: string | undefined
    for (const [id, call] of openToolCalls) {
      if (call.running) continue
      if (call.toolName === toolName) return id
      fallback ??= id
    }
    return fallback
  }

  const sendNotice = (notice: AcpNotice): void => {
    noticeSeq += 1
    send(noticeUpdate(notice, { clientNotices, fallbackMessageId: `notice-${noticeSeq}` }))
  }
  const pushConfigOptions = (): void => {
    send({ sessionUpdate: "config_option_update", configOptions: buildConfigOptions(runtime) })
  }

  const encode = (event: AgentEvent): void => {
    switch (event.type) {
      case "text_delta":
      case "thinking_delta": {
        const wire = toWireMessageDelta(event)
        send({
          sessionUpdate: wire.channel === "answer" ? "agent_message_chunk" : "agent_thought_chunk",
          messageId: wire.messageId,
          content: { type: "text", text: wire.text },
        })
        return
      }
      case "tool_call": {
        const wire = toWireToolStarted(event)
        openToolCalls.set(wire.toolCallId, { toolName: wire.toolName, running: false })
        const locations = toolLocations(wire.toolName, wire.input, cwd)
        send({
          sessionUpdate: "tool_call",
          toolCallId: wire.toolCallId,
          title: wire.summary ? `${wire.toolName}: ${wire.summary}` : wire.toolName,
          kind: toAcpToolKind(toolKindOf(wire.toolName)),
          status: toAcpToolStatus(toolStatusOf(event)),
          rawInput: wire.input,
          ...(locations.length > 0 ? { locations } : {}),
        })
        for (const done of toolCallWaiters.get(wire.toolCallId) ?? []) done()
        return
      }
      case "status": {
        if (event.phase !== "running_tool") return
        const id = nextToRun(event.toolName)
        const call = id === undefined ? undefined : openToolCalls.get(id)
        if (id === undefined || !call) return
        call.running = true
        send({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: toAcpToolStatus("running"),
        })
        return
      }
      case "tool_output": {
        const wire = toWireToolProgress(event)
        send({
          sessionUpdate: "tool_call_update",
          toolCallId: wire.toolCallId,
          content: [{ type: "content", content: { type: "text", text: wire.text } }],
          ...(wire.truncated
            ? {
                _meta: {
                  "minimal-agent/truncated": true,
                  "minimal-agent/totalBytes": wire.totalBytes,
                },
              }
            : {}),
        })
        return
      }
      case "tool_result": {
        const wire = toWireToolFinished(event)
        openToolCalls.delete(wire.toolCallId)
        send({
          sessionUpdate: "tool_call_update",
          toolCallId: wire.toolCallId,
          status: toAcpToolStatus(wire.status),
        })
        return
      }
      case "turn_completed": {
        lastStopReason = event.stopReason
        const usage = toWireUsage(event.usage)
        const size = runtime.modelInfo(runtime.getModel())?.contextWindow
        // `size` is required by ACP; with no known window, send nothing.
        if (size === undefined || size <= 0) return
        send({
          sessionUpdate: "usage_update",
          used: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
          size,
        })
        return
      }
      case "notice": {
        const { notice } = event
        if (STOP_NOTICE_KINDS.has(notice.kind)) lastNotice = notice
        if (notice.kind === "model_adopted") pushConfigOptions()
        sendNotice(toAcpNotice(notice))
        return
      }
      case "error":
        lastError = { message: event.message, ...(event.code ? { code: event.code } : {}) }
        return
      default:
        return
    }
  }

  const finishTurn = (outcome: StopInputs["outcome"]): TurnReply => {
    let decision: StopDecision
    try {
      decision = decideStopReason({ outcome, lastStopReason, lastNotice, lastError })
    } finally {
      lastStopReason = undefined
      lastNotice = null
      lastError = null
      openToolCalls.clear()
    }
    if (decision.notice) sendNotice(decision.notice)
    if (decision.kind === "error") {
      return { kind: "error", code: decision.code, message: decision.message }
    }
    return {
      kind: "reply",
      result: {
        stopReason: decision.stopReason,
        ...(decision.meta ? { _meta: decision.meta } : {}),
      },
    }
  }

  return { encode, finishTurn, pushConfigOptions, toolCallSent }
}
