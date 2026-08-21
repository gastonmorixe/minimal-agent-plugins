/**
 * Shared tracker instance for the tps plugin.
 *
 * The `llm.outputDelta` event handler (on_output_delta.ts) writes samples;
 * the live-area slot handler (handler.ts) reads them for display. Both
 * import this module-level singleton — one tracker per agent process,
 * matching the one-stream-at-a-time reality of the host's send loop.
 *
 * @module tps/tracker-holder
 */

import { TpsTracker } from "./tps-tracker.ts"

export const tracker = new TpsTracker()
