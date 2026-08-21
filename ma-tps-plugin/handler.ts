/**
 * Live-area slot handler for the tps plugin.
 *
 * Reads the shared {@link tracker} — fed by the `llm.outputDelta` event
 * handler (on_output_delta.ts) as streamed token batches arrive — and
 * publishes the windowed rate as an inline footer tail via
 * `ctx.setFooterTail`.
 *
 * CONTRACT: this handler ALWAYS returns null. The visual lives exclusively
 * in the footer tail — returning a string would paint a second row AND
 * double-render (a unit test pins this).
 *
 * Requires a companion footer plugin (quota-status) to be visible: the host
 * drops tails when there are no other footer lines.
 *
 * @module tps/handler
 */

import type { LiveAreaHandlerContext } from "./host-types.ts"
import { renderTpsTail } from "./render.ts"
import { tracker } from "./tracker-holder.ts"

/**
 * Live-area slot handler: read → render → publish the footer tail.
 * See the module docstring for the full contract.
 */
export default async function handle(ctx: LiveAreaHandlerContext): Promise<null> {
  const reading = tracker.read(performance.now())
  ctx.setFooterTail?.(renderTpsTail(reading.tps, reading.active))
  // Always null — see module docstring contract.
  return null
}
