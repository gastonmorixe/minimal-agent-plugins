/**
 * `tool.didBatch` listener: the reflection checkpoint.
 *
 * At each round that is a multiple of the interval, before the next model
 * request:
 *
 * 1. When an ack silenced this checkpoint, decrement the count and do nothing.
 * 2. Else wait the cooldown through `ctx.countdown` (the terminal host shows
 *    "label · Ns remaining · press Esc to skip"; a headless host waits a
 *    plain timer). An abort of the turn ends the wait and adds no text.
 * 3. Return the checkpoint attachment as `additionalContext`. Core adds it to
 *    the user content of the next request.
 *
 * @module handlers/did-batch
 */

import { loadConfig } from "../lib/config.ts"
import type { DidBatchResult, HookContext, ToolDidBatchPayload } from "../lib/host-types.ts"
import { sessionKey, stateFor } from "../lib/state.ts"
import { attachmentText } from "../lib/text.ts"

/** The countdown id (host status row and input capture). */
export const COUNTDOWN_ID = "reflection-checkpoint.cooldown"

/** The countdown label. The host adds the time left and the skip hint. */
export function countdownLabel(round: number): string {
  return `reflection @ round ${round}`
}

/** Injectable clock, for tests. */
export interface DidBatchDeps {
  now: () => number
}

const DEFAULT_DEPS: DidBatchDeps = { now: () => Date.now() }

/**
 * Run the checkpoint logic for one finished tool round.
 *
 * @param payload - The `tool.didBatch` payload (`round` is 1-based in the run).
 * @param ctx - The hook handler context.
 * @param deps - The clock (tests only).
 * @returns The attachment as `additionalContext`, or nothing.
 */
export async function onDidBatch(
  payload: ToolDidBatchPayload,
  ctx: HookContext,
  deps: DidBatchDeps = DEFAULT_DEPS,
): Promise<DidBatchResult> {
  const round = payload?.round
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1) return undefined
  const { interval, cooldownMs } = loadConfig(ctx.env)
  if (interval <= 0) return undefined

  const state = stateFor(sessionKey(ctx.agent, ctx.env))
  // A new run starts at round 1 again: clear an old count, but keep an ack
  // that the first response of this run wrote.
  if (round <= state.lastRound && !state.ackSinceBatch) state.silenceRemaining = 0
  state.lastRound = round
  state.ackSinceBatch = false

  if (round % interval !== 0) return undefined
  if (state.silenceRemaining > 0) {
    state.silenceRemaining -= 1
    return undefined
  }

  let appliedMs = 0
  if (cooldownMs > 0) {
    const start = deps.now()
    const result = await ctx.countdown({
      id: COUNTDOWN_ID,
      label: countdownLabel(round),
      ms: cooldownMs,
      signal: ctx.abort,
    })
    if (result === "aborted") return undefined
    appliedMs = result === "elapsed" ? cooldownMs : Math.max(0, deps.now() - start)
  }
  return { additionalContext: [attachmentText(round, appliedMs)] }
}

/** The manifest hook entry. */
export default function didBatch(
  payload: ToolDidBatchPayload,
  ctx: HookContext,
): Promise<DidBatchResult> {
  return onDidBatch(payload, ctx)
}
