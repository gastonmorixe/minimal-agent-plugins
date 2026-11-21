/**
 * Prompt fragment (placement `afterInstructions`): the "Tool loop safety"
 * section of the system prompt. It tells the model the configured interval
 * and cooldown, and the ack syntax. It returns a template (`{ template, vars }`)
 * and core renders it. The loader runs it one time at boot and
 * keeps the text for the session, so the system prompt stays byte-stable.
 * With interval 0 it gives `""` (no section).
 *
 * @module handlers/fragment
 */

import { pluginConfig } from "../lib/config.ts"
import type { FragmentContext, PromptTemplateText } from "../lib/host-types.ts"
import { loopSafetyText } from "../lib/text.ts"

/** The manifest prompt-fragment entry. */
export default function loopSafetyFragment(ctx: FragmentContext): PromptTemplateText | "" {
  const { interval, cooldownMs } = pluginConfig(ctx.env)
  return loopSafetyText(interval, cooldownMs)
}
