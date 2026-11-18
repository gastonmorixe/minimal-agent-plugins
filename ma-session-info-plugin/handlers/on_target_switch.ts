/**
 * `target.didSwitch` event listener: record the switch for the model's next
 * turn. See `lib/target-notes.ts`.
 *
 * CONTRACT: the loader calls `fn(ctx)`; `ctx.payload` is `{from, to}`.
 */

import { recordSwitch } from "../lib/target-notes.ts"

/** Record the switch in `ctx.payload`. */
export default function handle(ctx: { payload?: unknown }): void {
  recordSwitch(ctx?.payload)
}
