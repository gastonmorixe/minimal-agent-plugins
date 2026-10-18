/**
 * Tool-call handler for `PromptEdit`.
 *
 * Updates an existing prompt's description and/or body, and optionally
 * renames it. Only the fields supplied are changed.
 *
 * @module handlers/prompt_edit
 */

import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { invalidateItems } from "../lib/menu.ts"
import { editPrompt } from "../lib/store.ts"

import { depsFor, errResult } from "./shared.ts"

const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") return errResult("PromptEdit", "wrong trigger type")
  const input = ctx.trigger.input

  const name = typeof input.name === "string" ? input.name.trim() : ""
  if (!name) return errResult("PromptEdit", "`name` is required")

  const patch: { name: string; description?: string; body?: string; rename?: string } = { name }
  if (typeof input.description === "string") patch.description = input.description.trim()
  if (typeof input.body === "string") patch.body = input.body
  if (typeof input.rename === "string" && input.rename.trim()) patch.rename = input.rename.trim()

  if (patch.description === undefined && patch.body === undefined && patch.rename === undefined) {
    return errResult("PromptEdit", "supply at least one of: description, body, rename")
  }

  const result = editPrompt(depsFor(ctx), patch)
  if (!result.ok) return errResult("PromptEdit", result.error)

  invalidateItems()
  return {
    kind: "tool_result",
    content: `Updated prompt "${result.prompt.slug}".`,
    displayHeader: `updated  ${result.prompt.slug}`,
    displayFooter: result.prompt.path,
  }
}

export default handler
