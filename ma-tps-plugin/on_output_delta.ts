/**
 * Event handler for the host's `llm.outputDelta` channel.
 *
 * The host emits `{deltaTokens}` per batched stream chunk (see core
 * `src/llm/transport/stream-delta.ts`). This handler feeds each batch into
 * the shared {@link TpsTracker} with a monotonic timestamp. The live-area
 * slot handler (`handler.ts`) reads the tracker on its own cadence to
 * render the footer tail — the two are decoupled so event bursts never
 * force terminal repaints.
 *
 * @module tps/on_output_delta
 */

import type { EventHandlerContext } from "./host-types.ts"
import { tracker } from "./tracker-holder.ts"

/**
 * Event handler: feed one `llm.outputDelta` payload into the shared
 * tracker. Malformed payloads are ignored as noise.
 *
 * CONTRACT: the loader always calls `fn(ctx)` with
 * {@link EventHandlerContext}. Reading `input.deltaTokens` directly
 * (as if the bus payload were the first argument) silently no-ops
 * every production event and leaves the footer blank.
 */
export default function handle(ctx: EventHandlerContext | unknown): void {
  const deltaTokens = extractDeltaTokens(ctx)
  if (typeof deltaTokens !== "number") return
  tracker.sample(performance.now(), deltaTokens)
}

/**
 * Pull `deltaTokens` out of either an EventHandlerContext or a raw
 * `{deltaTokens}` payload. Production always sends the context; the
 * raw shape is accepted so a test (or a future bus-shape tweak) cannot
 * starve the tracker the same way again.
 */
function extractDeltaTokens(input: unknown): number | undefined {
  if (!input || typeof input !== "object") return undefined
  const rec = input as Record<string, unknown>
  if (typeof rec.deltaTokens === "number") return rec.deltaTokens
  const inner = rec.payload
  if (inner && typeof inner === "object") {
    const n = (inner as { deltaTokens?: unknown }).deltaTokens
    if (typeof n === "number") return n
  }
  return undefined
}
