/**
 * Event handler for the host's `llm.outputEnd` channel.
 *
 * The host emits this once in the stream `finally` after the last
 * delta flush (`{reason:"stream_end"}`), covering clean end, error,
 * and salvage. That is BEFORE tool IO, so a minutes-long Bash run
 * never hangs a stale rate. Repeat signals are idempotent.
 *
 * CONTRACT: the loader always calls `fn(ctx)` with EventHandlerContext.
 *
 * @module tps/on_output_end
 */

import { tracker } from "./tracker-holder.ts"

/** Hide the readout. Payload is ignored; any well-formed event is an end. */
export default function handle(_ctx: unknown): void {
  tracker.markInactive()
}
