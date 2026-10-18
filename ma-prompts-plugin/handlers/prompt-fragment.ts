/**
 * Prompt-fragment producer: the saved-prompt catalog.
 *
 * Emitted into the system prompt at session start so the model knows the
 * library exists and how to grow it. This is a *catalog*, not the bodies:
 * bodies cost tokens and the user rarely needs all of them.
 *
 * When the library is empty the producer still teaches the tools once, so the
 * model knows how to save the first prompt.
 *
 * @module handlers/prompt-fragment
 */

import { loadPromptsConfig } from "../lib/config.ts"
import type { PromptFragmentContext } from "../lib/host-types.ts"
import { defaultDeps, loadPrompts } from "../lib/store.ts"

const handler = (ctx: PromptFragmentContext): string => {
  const config = loadPromptsConfig()
  if (!config.enabled) return ""

  const deps = defaultDeps(ctx.env, ctx.cwd, config.projectScope, {
    maxBodyBytes: config.maxBodyBytes,
    maxPrompts: config.maxPrompts,
  })
  const { prompts } = loadPrompts(deps)

  const sigil = config.sigil
  const lines: string[] = []

  if (prompts.length === 0) {
    lines.push("## Saved prompts")
    lines.push("")
    lines.push(
      `No prompts saved yet. Save one when the user asks you to remember a reusable prompt, then they can recall it by typing \`${sigil}name\`.`,
    )
    return lines.join("\n")
  }

  lines.push(`## Saved prompts (${prompts.length})`)
  lines.push("")
  lines.push(`Type \`${sigil}\` for the autocomplete menu, or \`${sigil}name\` to use one.`)
  lines.push("")
  for (const p of prompts) {
    const desc = p.description ? `  ${p.description}` : ""
    lines.push(`- \`${sigil}${p.slug}\`${desc}`)
  }
  return lines.join("\n")
}

export default handler
