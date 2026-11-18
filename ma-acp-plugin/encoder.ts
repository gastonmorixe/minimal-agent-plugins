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
 * - `status` phase `retrying` or `waiting_for_quota` → one notice for a long
 *   wait (see `wait-notice.ts` for the rules and the text). Without it the
 *   client shows nothing while the session waits.
 * - `tool_output` → `tool_call_update` with the (capped) text as content.
 * - `tool_result` → `tool_call_update` `completed` or `failed`. When the outcome
 *   has structured `data`, the update also has it as `rawOutput`.
 * - `turn_completed` → `usage_update`: `used` = that turn's input + cache
 *   read + cache creation tokens (a PROXY for the context size, never a
 *   sum over turns), `size` = the model's `contextWindow`. No cost.
 *   The encoder also adds the round's tokens to per-prompt counters.
 * - {@link SessionEncoder.finishTurn} puts the counters on every reply with
 *   a `stopReason` (also `cancelled`) and resets them: the standard
 *   `PromptResponse.usage` (best effort, always) and
 *   `_meta["minimal-agent/usage"]` when `usage` is in the effective
 *   extension set (`docs/acp-extensions.md` section 5.a).
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
import { EXT_NAMESPACE, type ExtAdvert, hasExtFeature } from "./ext.ts"
import { type AcpNotice, noticeUpdate, toAcpNotice } from "./notices.ts"
import {
  decideStopReason,
  type ProviderStopReason,
  type StopDecision,
  type StopInputs,
} from "./stop-reason.ts"
import { createWaitNoticer } from "./wait-notice.ts"

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

/** Host text of a retry boundary (S14.4). Same bytes core used to emit as `text_delta`. */
export function retryBoundaryText(attempt: number): string {
  return `\n↳ stream stalled — retrying (attempt ${attempt})…\n`
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
  /** The effective L3 extension set from `initialize` (`ext.ts`). */
  readonly ext: ExtAdvert
}

/** The `_meta` key for per-prompt token totals (`docs/acp-extensions.md` section 5.a). */
export const USAGE_META_KEY = `${EXT_NAMESPACE}/usage`

/**
 * Token counters for one `session/prompt`, summed over every model round.
 * `inputTokens` is uncached input. A cache field is `undefined` until a
 * round reports it ("not reported", not zero).
 */
export interface PromptUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number | undefined
  cacheWriteTokens: number | undefined
}

const emptyPromptUsage = (): PromptUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: undefined,
  cacheWriteTokens: undefined,
})

/** `_meta["minimal-agent/usage"]`: uncached input, cache fields apart. No `thoughtTokens`, no `cost` (not known). */
export function toUsageMeta(u: PromptUsage): Record<string, number> {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    ...(u.cacheReadTokens === undefined ? {} : { cacheReadTokens: u.cacheReadTokens }),
    ...(u.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: u.cacheWriteTokens }),
  }
}

/**
 * Standard `PromptResponse.usage` (unstable ACP `Usage`), best effort:
 * `inputTokens` is the full prompt size (input + cache read + cache write),
 * `totalTokens` = `inputTokens + outputTokens`.
 */
export function toStandardUsage(u: PromptUsage): Record<string, number> {
  const inputTokens = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
  return {
    totalTokens: inputTokens + u.outputTokens,
    inputTokens,
    outputTokens: u.outputTokens,
    ...(u.cacheReadTokens === undefined ? {} : { cachedReadTokens: u.cacheReadTokens }),
    ...(u.cacheWriteTokens === undefined ? {} : { cachedWriteTokens: u.cacheWriteTokens }),
  }
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
  const { send, clientNotices, runtime, cwd, ext } = options
  const usageMeta = hasExtFeature(ext, "usage")
  let promptUsage = emptyPromptUsage()
  let noticeSeq = 0
  let lastStopReason: ProviderStopReason | undefined
  let lastNotice: TurnNotice | null = null
  let lastError: {
    message: string
    code?: string
    error?: { readonly kind: string; readonly fields: Readonly<Record<string, unknown>> }
  } | null = null
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
  // A long retry or quota wait gives a notice. All rules are in `wait-notice.ts`.
  const waitNoticer = createWaitNoticer()
  const sendWaitNotice = (status: Extract<AgentEvent, { type: "status" }>): void => {
    const notice = waitNoticer.notice(status)
    if (notice) sendNotice(notice)
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
      case "retry-boundary": {
        // S14.4: core sends data. The host text is the same chunk core used to send.
        send({
          sessionUpdate: "agent_message_chunk",
          messageId: event.id,
          content: { type: "text", text: retryBoundaryText(event.attempt) },
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
        if (event.phase !== "running_tool") return sendWaitNotice(event)
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
          ...(wire.data !== undefined ? { rawOutput: wire.data } : {}),
        })
        return
      }
      case "turn_completed": {
        lastStopReason = event.stopReason
        const usage = toWireUsage(event.usage)
        promptUsage.inputTokens += usage.inputTokens
        promptUsage.outputTokens += usage.outputTokens
        if (usage.cacheReadTokens !== undefined) {
          promptUsage.cacheReadTokens = (promptUsage.cacheReadTokens ?? 0) + usage.cacheReadTokens
        }
        if (usage.cacheCreationTokens !== undefined) {
          promptUsage.cacheWriteTokens =
            (promptUsage.cacheWriteTokens ?? 0) + usage.cacheCreationTokens
        }
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
        // A CoreError event has message "" and carries `error` {kind, fields}.
        lastError = {
          message: event.message,
          ...(event.code ? { code: event.code } : {}),
          ...(event.error ? { error: event.error } : {}),
        }
        return
      default:
        return
    }
  }

  const finishTurn = (outcome: StopInputs["outcome"]): TurnReply => {
    let decision: StopDecision
    const counted = promptUsage
    try {
      decision = decideStopReason({ outcome, lastStopReason, lastNotice, lastError })
    } finally {
      lastStopReason = undefined
      lastNotice = null
      lastError = null
      openToolCalls.clear()
      promptUsage = emptyPromptUsage()
      waitNoticer.reset()
    }
    if (decision.notice) sendNotice(decision.notice)
    if (decision.kind === "error") {
      return { kind: "error", code: decision.code, message: decision.message }
    }
    const meta = {
      ...decision.meta,
      ...(usageMeta ? { [USAGE_META_KEY]: toUsageMeta(counted) } : {}),
    }
    return {
      kind: "reply",
      result: {
        stopReason: decision.stopReason,
        usage: toStandardUsage(counted),
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      },
    }
  }

  return { encode, finishTurn, pushConfigOptions, toolCallSent }
}
