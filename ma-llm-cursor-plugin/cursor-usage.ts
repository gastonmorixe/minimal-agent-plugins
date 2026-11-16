/**
 * Accumulate Cursor wire usage into CanonicalUsage.
 *
 * Evidence (cursor-agent 2026.11.13-eacade1 + live Dashboard GetFilteredUsageEvents):
 * - ConversationTokenDetails: used_tokens #1 u32, max_tokens #2 u32 (absolute
 *   conversation occupancy / server window — prefer for context bar denominator).
 * - TurnEndedUpdate (#14) / ModelCallCompletedUpdate (#31): input/output/
 *   cache_read/cache_write/reasoning. Wire `input` INCLUDES cache read+write;
 *   official CLI `$()` does `max(input - cacheRead - cacheWrite, 0)`.
 * - Latest model_call_completed replaces prior call totals (not summed) so
 *   contextSize stays one-prompt footprint, not Σ(calls).
 * - checkpoint.used_tokens is fallback when no turn/model-call usage arrived.
 *
 * @module llm/providers/cursor/cursor-usage
 */

import type { CanonicalUsage } from "@minimal-agent/core/plugin-api/llm/canonical-events"

import type { CursorServerEvent } from "./proto/agent-run.ts"

/** Mutable usage/summary snapshot for one translator session. */
export type CursorUsageState = {
  /** From conversation_checkpoint_update → token_details.used_tokens. */
  usedTokens?: number
  /** Latest InteractionUpdate.token_delta.tokens (fallback only). */
  tokenDeltaTokens?: number
  /** From token_details.max_tokens. */
  maxTokens?: number
  /** True once TurnEnded or ModelCallCompleted supplied any token field. */
  hasWireUsage?: boolean
  /** Wire totals (input INCLUDES cache). Latest model-call / turn-ended. */
  wireInputTokens?: number
  wireOutputTokens?: number
  wireCacheReadTokens?: number
  wireCacheWriteTokens?: number
  wireReasoningTokens?: number
  summaryStarted?: boolean
  summaryText?: string
  summaryCompletedHook?: string
}

/** Latest checkpoint max_tokens seen on any Cursor stream in this process. */
let lastSeenMaxTokens: number | undefined
/** Latest checkpoint used_tokens (absolute conversation occupancy). */
let lastSeenUsedTokens: number | undefined

/** Test helper: clear the process-level token notes. */
export function clearCursorLastMaxTokens(): void {
  lastSeenMaxTokens = undefined
  lastSeenUsedTokens = undefined
}

/** Latest server-reported conversation max_tokens (for status-bar contextWindow). */
export function getCursorLastMaxTokens(): number | undefined {
  return lastSeenMaxTokens
}

/** Latest server-reported used_tokens. */
export function getCursorLastUsedTokens(): number | undefined {
  return lastSeenUsedTokens
}

/**
 * Context-window denominator for the status bar: prefer server max_tokens,
 * but never report a window smaller than the latest used_tokens (Auto can
 * report used > catalog 128k, which made `128k … 143k` unreadable).
 */
export function getCursorContextWindowForStatus(): number | undefined {
  const max = lastSeenMaxTokens
  const used = lastSeenUsedTokens
  if (max != null && max > 0 && used != null && used > max) return used
  if (max != null && max > 0) return max
  return undefined
}

function noteMaxTokens(n: number | undefined): void {
  if (typeof n === "number" && Number.isFinite(n) && n > 0) lastSeenMaxTokens = n
}

function noteUsedTokens(n: number | undefined): void {
  if (typeof n === "number" && Number.isFinite(n) && n >= 0) lastSeenUsedTokens = n
}

function hasAnyWireToken(ev: CursorServerEvent): boolean {
  return (
    typeof ev.inputTokens === "number" ||
    typeof ev.outputTokens === "number" ||
    typeof ev.cacheReadTokens === "number" ||
    typeof ev.cacheWriteTokens === "number" ||
    typeof ev.reasoningTokens === "number"
  )
}

function applyWireTokenFields(state: CursorUsageState, ev: CursorServerEvent): void {
  if (!hasAnyWireToken(ev)) return
  state.hasWireUsage = true
  // Replace (latest model call / turn total), matching cursor-agent stream UI.
  if (typeof ev.inputTokens === "number") state.wireInputTokens = ev.inputTokens
  if (typeof ev.outputTokens === "number") state.wireOutputTokens = ev.outputTokens
  if (typeof ev.cacheReadTokens === "number") state.wireCacheReadTokens = ev.cacheReadTokens
  if (typeof ev.cacheWriteTokens === "number") state.wireCacheWriteTokens = ev.cacheWriteTokens
  if (typeof ev.reasoningTokens === "number") state.wireReasoningTokens = ev.reasoningTokens
}

/** Apply one decoded server event onto usage/summary state. */
export function applyCursorUsageEvent(state: CursorUsageState, ev: CursorServerEvent): void {
  if (ev.kind === "token_delta" && typeof ev.tokens === "number") {
    state.tokenDeltaTokens = ev.tokens
    return
  }
  if (ev.kind === "conversation_checkpoint_update") {
    if (typeof ev.usedTokens === "number") {
      state.usedTokens = ev.usedTokens
      noteUsedTokens(ev.usedTokens)
    }
    if (typeof ev.maxTokens === "number") {
      state.maxTokens = ev.maxTokens
      noteMaxTokens(ev.maxTokens)
    }
    return
  }
  if (ev.kind === "model_call_completed" || ev.kind === "turn_ended") {
    applyWireTokenFields(state, ev)
    return
  }
  if (ev.kind === "summary_started") {
    state.summaryStarted = true
    return
  }
  if (ev.kind === "summary" && typeof ev.text === "string") {
    state.summaryText = ev.text
    return
  }
  if (ev.kind === "summary_completed") {
    if (typeof ev.hookMessage === "string") state.summaryCompletedHook = ev.hookMessage
    else state.summaryCompletedHook = state.summaryCompletedHook ?? ""
  }
}

/**
 * Map accumulated Cursor usage to CanonicalUsage.
 *
 * Prefer TurnEnded / ModelCallCompleted (with CLI `$()` cache subtract).
 * Else checkpoint used_tokens as absolute occupancy (no fabricated cache).
 */
export function cursorUsageToCanonical(state: CursorUsageState): CanonicalUsage {
  if (state.hasWireUsage) {
    const cacheRead = state.wireCacheReadTokens ?? 0
    const cacheWrite = state.wireCacheWriteTokens ?? 0
    const wireIn = state.wireInputTokens ?? 0
    const uncached = Math.max(wireIn - cacheRead - cacheWrite, 0)
    const usage: CanonicalUsage = {
      inputTokens: uncached,
      outputTokens: state.wireOutputTokens ?? 0,
    }
    if (cacheRead > 0) usage.cacheReadTokens = cacheRead
    if (cacheWrite > 0) usage.cacheCreationTokens = cacheWrite
    if (state.wireReasoningTokens && state.wireReasoningTokens > 0) {
      usage.reasoningTokens = state.wireReasoningTokens
    }
    return usage
  }

  // Checkpoint path: used_tokens is absolute conversation size, not per-turn prefill.
  // Prefer it over token_delta when both exist. No cache keys inventable here.
  const inputTokens = state.usedTokens ?? state.tokenDeltaTokens ?? 0
  return { inputTokens, outputTokens: 0 }
}

/** Provider receipts for message_delta (max tokens + summary lifecycle + wire). */
export function cursorUsageReceipts(state: CursorUsageState): Record<string, unknown> | undefined {
  const receipts: Record<string, unknown> = {}
  if (typeof state.maxTokens === "number") receipts.cursorMaxTokens = state.maxTokens
  if (typeof state.tokenDeltaTokens === "number") {
    receipts.cursorTokenDeltaTokens = state.tokenDeltaTokens
  }
  if (typeof state.usedTokens === "number") receipts.cursorUsedTokens = state.usedTokens
  if (state.hasWireUsage) {
    if (typeof state.wireInputTokens === "number") {
      receipts.cursorWireInputTokens = state.wireInputTokens
    }
    if (typeof state.wireCacheReadTokens === "number") {
      receipts.cursorWireCacheReadTokens = state.wireCacheReadTokens
    }
    if (typeof state.wireCacheWriteTokens === "number") {
      receipts.cursorWireCacheWriteTokens = state.wireCacheWriteTokens
    }
  }
  if (state.summaryStarted) receipts.cursorSummaryStarted = true
  if (typeof state.summaryText === "string") receipts.cursorSummary = state.summaryText
  if (typeof state.summaryCompletedHook === "string") {
    receipts.cursorSummaryCompletedHook = state.summaryCompletedHook
  }
  return Object.keys(receipts).length > 0 ? receipts : undefined
}
