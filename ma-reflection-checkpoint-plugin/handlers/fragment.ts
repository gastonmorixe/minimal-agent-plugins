/**
 * Prompt fragment (placement `afterInstructions`): the "Tool loop safety"
 * section of the system prompt. It tells the model the configured interval
 * and cooldown, and the ack syntax. The loader runs it one time at boot and
 * keeps the text for the session, so the system prompt stays byte-stable.
 * With interval 0 it gives `""` (no section).
 *
 * @module handlers/fragment
 */

import { loadConfig } from "../lib/config.ts"
import type { FragmentContext } from "../lib/host-types.ts"
import { loopSafetyText } from "../lib/text.ts"

/** The manifest prompt-fragment entry. */
export default function loopSafetyFragment(ctx: FragmentContext): string {
  const { interval, cooldownMs } = loadConfig(ctx.env)
  return loopSafetyText(interval, cooldownMs)
}
