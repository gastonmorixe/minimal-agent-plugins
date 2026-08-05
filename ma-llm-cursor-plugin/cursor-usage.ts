/**
 * Accumulate Cursor wire usage into CanonicalUsage.
 *
 * Evidence (cursor-agent 2026.07.23-e383d2b):
 * - ConversationTokenDetails: used_tokens #1 u32, max_tokens #2 u32
 * - TokenDeltaUpdate: tokens #1 i32 (schema does not prove absolute vs delta)
 * - checkpoint.used_tokens wins over token_delta when both seen
 * - No prompt/completion split → outputTokens stays 0 (unreported)
 *
 * @module llm/providers/cursor/cursor-usage
 */

import type { CanonicalUsage } from "./lib/canonical-events.ts"
import type { CursorServerEvent } from "./proto/agent-run.ts"

/** Mutable usage/summary snapshot for one translator session. */
export type CursorUsageState = {
  /** From conversation_checkpoint_update → token_details.used_tokens. */
  usedTokens?: number
  /** Latest InteractionUpdate.token_delta.tokens (fallback only). */
  tokenDeltaTokens?: number
  /** From token_details.max_tokens. */
  maxTokens?: number
  summaryStarted?: boolean
  summaryText?: string
  summaryCompletedHook?: string
}

/** Apply one decoded server event onto usage/summary state. */
export function applyCursorUsageEvent(state: CursorUsageState, ev: CursorServerEvent): void {
  if (ev.kind === "token_delta" && typeof ev.tokens === "number") {
    state.tokenDeltaTokens = ev.tokens
    return
  }
  if (ev.kind === "conversation_checkpoint_update") {
    if (typeof ev.usedTokens === "number") state.usedTokens = ev.usedTokens
    if (typeof ev.maxTokens === "number") state.maxTokens = ev.maxTokens
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
 * checkpoint.used_tokens wins; else latest token_delta; else 0.
 * outputTokens is always 0 (no evidenced completion counter).
 */
export function cursorUsageToCanonical(state: CursorUsageState): CanonicalUsage {
  const inputTokens = state.usedTokens ?? state.tokenDeltaTokens ?? 0
  return { inputTokens, outputTokens: 0 }
}

/** Provider receipts for message_delta (max tokens + summary lifecycle). */
export function cursorUsageReceipts(state: CursorUsageState): Record<string, unknown> | undefined {
  const receipts: Record<string, unknown> = {}
  if (typeof state.maxTokens === "number") receipts.cursorMaxTokens = state.maxTokens
  if (typeof state.tokenDeltaTokens === "number") {
    receipts.cursorTokenDeltaTokens = state.tokenDeltaTokens
  }
  if (typeof state.usedTokens === "number") receipts.cursorUsedTokens = state.usedTokens
  if (state.summaryStarted) receipts.cursorSummaryStarted = true
  if (typeof state.summaryText === "string") receipts.cursorSummary = state.summaryText
  if (typeof state.summaryCompletedHook === "string") {
    receipts.cursorSummaryCompletedHook = state.summaryCompletedHook
  }
  return Object.keys(receipts).length > 0 ? receipts : undefined
}
