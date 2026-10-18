/**
 * Tool-call handler for `PromptNew`.
 *
 * Saves a reusable prompt. The model calls this when the user says "save this
 * as a prompt". Fails on a name collision unless `overwrite` is true.
 *
 * @module handlers/prompt_new
 */

import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { invalidateItems } from "../lib/menu.ts"
import { createPrompt } from "../lib/store.ts"

import { clip, depsFor, errResult } from "./shared.ts"

const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") return errResult("PromptNew", "wrong trigger type")
  const input = ctx.trigger.input

  const name = typeof input.name === "string" ? input.name.trim() : ""
  const body = typeof input.body === "string" ? input.body : ""
  const description = typeof input.description === "string" ? input.description.trim() : ""
  const overwrite = input.overwrite === true

  if (!name) return errResult("PromptNew", "`name` is required")
  if (!body.trim()) return errResult("PromptNew", "`body` is required")

  const result = createPrompt(depsFor(ctx), { name, description, body, overwrite })
  if (!result.ok) return errResult("PromptNew", result.error)

  invalidateItems()
  const preview = clip(result.prompt.body.split("\n")[0] ?? "", 80)
  return {
    kind: "tool_result",
    content: `Saved prompt "${result.prompt.slug}" (${result.prompt.body.length} chars). Use it by typing &${result.prompt.slug} in a message.`,
    displayHeader: `saved  ${result.prompt.slug}`,
    display: preview,
    displayFooter: result.prompt.path,
  }
}

export default handler
